/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
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

import type { Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS, OBJECT_CLASSES } from '@authrim/ar-lib-core';

import {
  auditWrite,
  coreFakes,
  envFixture,
  mockAdapter,
  repoFakes,
  resetFakes,
  stepUpFakes,
} from './logging-control-b-harness';
import { ADMIN_LOGGING, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const OVERVIEW_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ];
const POLICY_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ];
const POLICY_UPDATE = [ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_UPDATE];
const OBJECT_CLASS = OBJECT_CLASSES[0];
const SENSITIVE_EXPORT = 'admin:logging:sensitive_detail:export';

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function destinationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dest_1',
    scope_type: 'platform',
    scope_id: 'global',
    destination_kind: 'object_storage',
    provider: 'r2',
    name: 'archive',
    lifecycle_status: 'active',
    health_status: 'healthy',
    provider_config: '{}',
    allowed_tenant_ids: null,
    allowed_log_types: null,
    allowed_planes: null,
    region: null,
    critical_allowed: 1,
    default_fallback_eligible: 0,
    retention_days: 30,
    encryption_mode: 'platform_managed',
    last_health_check_at: null,
    version: 3,
    ...overrides,
  };
}

describe('POST /sensitive-detail/probe', () => {
  const path = `${ADMIN_LOGGING}/sensitive-detail/probe`;
  const probeRow = (overrides: Record<string, unknown> = {}) => ({
    catalog_id: 'cat_1',
    tenant_id: 'tenant-a',
    object_class: OBJECT_CLASS,
    bucket_binding: 'SENSITIVE_DETAILS',
    object_key: 'sd/cat_1',
    content_encoding: 'gzip',
    line_number: '3',
    byte_offset: '10',
    byte_length: null,
    key_version: '2',
    checksum_sha256: 'sum',
    created_at: '55',
    deleted_at: null,
    public_artifact_id: 'art_1',
    ...overrides,
  });
  const app = () => createApp([SENSITIVE_EXPORT]);

  it('requires the sensitive-detail export permission and a catalog id', async () => {
    const denied = await call(createApp(OVERVIEW_READ), 'POST', path, { catalog_id: 'cat_1' });
    expect(denied.status).toBe(403);
    expect(denied.body.details.permission).toEqual({
      required_permission: SENSITIVE_EXPORT,
      reason: 'sensitive_detail_probe_permission_required',
    });
    const missing = await call(app(), 'POST', path, {});
    expect(missing.body.details.fields).toEqual([
      { path: 'catalog_id', code: 'required', message: 'Sensitive detail catalog id is required.' },
    ]);
    const foreign = await call(app(), 'POST', path, { catalog_id: 'cat_1', tenant_id: 'tenant-b' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.details.permission.reason).toBe('tenant_scope_mismatch');
  });

  it('searches the index, admin and primary databases in order and filters the lookup', async () => {
    coreFakes.ensureDatabaseAdapter.mockImplementation((source: unknown) => source);
    const indexDb = { queryOne: vi.fn().mockRejectedValue(new Error('index down')) };
    const primaryDb = { queryOne: vi.fn().mockResolvedValue(probeRow()) };
    const env = {
      ...envFixture,
      LOGGING_INDEX_DB: indexDb,
      DB: primaryDb,
      SENSITIVE_DETAILS: undefined,
    } as unknown as Env;
    mockAdapter.queryOne.mockResolvedValue(null);
    const res = await call(
      app(),
      'POST',
      path,
      {
        catalog_id: 'cat_1',
        tenant_id: ' tenant-a ',
        object_class: 'sensitive_detail',
        read_payload: true,
      },
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.body.item.adapter_binding).toBe('DB');
    expect(coreFakes.ensureDatabaseAdapter).toHaveBeenCalledWith(indexDb, 'sensitive-detail-probe');
    expect(coreFakes.ensureDatabaseAdapter).toHaveBeenCalledWith(
      primaryDb,
      'sensitive-detail-probe'
    );
    const [sql, params] = primaryDb.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'sdci.catalog_id = ? AND sdci.deleted_at IS NULL AND sdci.tenant_id = ? AND sdci.object_class = ?'
    );
    expect(params).toEqual(['cat_1', 'tenant-a', 'sensitive_detail']);
    expect(mockAdapter.queryOne).toHaveBeenCalledTimes(1);
  });

  it('answers 404 when no database has the chunk and 403 for another tenant', async () => {
    coreFakes.ensureDatabaseAdapter.mockReturnValue({ queryOne: vi.fn().mockResolvedValue(null) });
    expect((await call(app(), 'POST', path, { catalog_id: 'cat_1' })).status).toBe(404);
    const params = mockAdapter.queryOne.mock.calls[0][1];
    expect(params).toEqual(['cat_1', 'tenant-a']);
    mockAdapter.queryOne.mockResolvedValue(probeRow({ tenant_id: 'tenant-b' }));
    expect((await call(app(), 'POST', path, { catalog_id: 'cat_1' })).status).toBe(403);
  });

  it('maps the located chunk and reports the payload read outcome', async () => {
    mockAdapter.queryOne.mockResolvedValue(probeRow());
    const expectedBase = {
      catalog_id: 'cat_1',
      public_artifact_id: 'art_1',
      tenant_id: 'tenant-a',
      object_class: OBJECT_CLASS,
      bucket_binding: 'SENSITIVE_DETAILS',
      object_key: 'sd/cat_1',
      content_encoding: 'gzip',
      line_number: 3,
      byte_offset: 10,
      byte_length: null,
      key_version: 2,
      checksum_sha256: 'sum',
      created_at: 55,
      adapter_binding: 'DB_ADMIN',
    };
    const cases: Array<[unknown, string, string | null, 'success' | 'failure']> = [
      [{ a: 1 }, 'ok', 'object', 'success'],
      [[1, 2], 'ok', 'array', 'success'],
      ['text', 'ok', 'string', 'success'],
      [null, 'not_found_or_unreadable', null, 'failure'],
    ];
    for (const [value, readStatus, shape, result] of cases) {
      auditWrite.mockClear();
      coreFakes.loadChunkedSensitiveDetail.mockResolvedValue(value);
      const res = await call(app(), 'POST', path, { catalog_id: 'cat_1' });
      expect(res.status).toBe(200);
      expect(res.body.item).toEqual({
        ...expectedBase,
        read_status: readStatus,
        payload_shape: shape,
      });
      expect(coreFakes.loadChunkedSensitiveDetail).toHaveBeenLastCalledWith(
        mockAdapter,
        expect.anything(),
        { tenantId: 'tenant-a', objectCatalogId: 'cat_1', expectedClass: OBJECT_CLASS }
      );
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin_logging.sensitive_detail.probe',
          resourceType: 'sensitive_detail_chunk_index',
          resourceId: 'cat_1',
          result,
          severity: 'warn',
          metadata: {
            tenant_id: 'tenant-a',
            object_class: OBJECT_CLASS,
            adapter_binding: 'DB_ADMIN',
            read_status: readStatus,
          },
        })
      );
    }
  });

  it('skips, cannot or fails the payload read in the other cases', async () => {
    mockAdapter.queryOne.mockResolvedValue(probeRow());
    const skipped = await call(app(), 'POST', path, { catalog_id: 'cat_1', read_payload: false });
    expect(skipped.body.item.read_status).toBe('not_requested');
    expect(coreFakes.loadChunkedSensitiveDetail).not.toHaveBeenCalled();
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'success' })
    );

    const noBucket = await call(app(), 'POST', path, { catalog_id: 'cat_1' }, {}, {
      ...envFixture,
      SENSITIVE_DETAILS: undefined,
    } as unknown as Env);
    expect(noBucket.body.item.read_status).toBe('unavailable');
    const noKey = await call(app(), 'POST', path, { catalog_id: 'cat_1' }, {}, {
      ...envFixture,
      OBJECT_ENCRYPTION_ROOT_KEY: undefined,
    } as unknown as Env);
    expect(noKey.body.item.read_status).toBe('unavailable');

    mockAdapter.queryOne.mockResolvedValue(probeRow({ object_class: 'not_a_class' }));
    const badClass = await call(app(), 'POST', path, { catalog_id: 'cat_1' });
    expect(badClass.body.item.read_status).toBe('error');
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' })
    );

    mockAdapter.queryOne.mockResolvedValue(probeRow());
    coreFakes.loadChunkedSensitiveDetail.mockRejectedValue(new Error('decrypt'));
    const failed = await call(app(), 'POST', path, { catalog_id: 'cat_1' });
    expect(failed.body.item.read_status).toBe('error');
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' })
    );
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    coreFakes.ensureDatabaseAdapter.mockImplementation(() => {
      throw new Error('boom');
    });
    expect((await call(app(), 'POST', path, { catalog_id: 'cat_1' })).status).toBe(500);
  });
});

describe('PATCH /sensitive-detail-policy', () => {
  const path = `${ADMIN_LOGGING}/sensitive-detail-policy`;
  const body = {
    log_type: 'pii',
    destination_id: 'dest_1',
    confirmation: 'CHANGE SENSITIVE DETAIL pii',
  };
  const arrange = (
    destination: Record<string, unknown> | null = destinationRow(),
    assigned = true
  ) =>
    mockAdapter.queryOne.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM admin_destinations')
        ? destination
        : String(sql).includes('storage_destination_assignments')
          ? assigned
            ? { id: 'sda_1' }
            : null
          : null
    );

  it('requires the policy update permission and a valid body', async () => {
    expect((await call(createPlatformApp(POLICY_READ), 'PATCH', path, body)).status).toBe(403);
    const res = await call(createPlatformApp(POLICY_UPDATE), 'PATCH', path, {});
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'log_type', code: 'invalid_value', message: 'Log type is not supported.' },
      { path: 'destination_id', code: 'required', message: 'Destination id is required.' },
    ]);
    const onlyDestination = await call(createPlatformApp(POLICY_UPDATE), 'PATCH', path, {
      log_type: 'pii',
    });
    expect(onlyDestination.body.details.fields.map((f: { path: string }) => f.path)).toEqual([
      'destination_id',
    ]);
    const onlyType = await call(createPlatformApp(POLICY_UPDATE), 'PATCH', path, {
      destination_id: 'd',
      log_type: 'zz',
    });
    expect(onlyType.body.details.fields.map((f: { path: string }) => f.path)).toEqual(['log_type']);
  });

  it('demands the exact confirmation and an eligible destination', async () => {
    const app = createPlatformApp(POLICY_UPDATE);
    for (const confirmation of [undefined, 'CHANGE SENSITIVE DETAIL audit']) {
      const res = await call(app, 'PATCH', path, { ...body, confirmation });
      expect(res.body.details.fields).toEqual([
        {
          path: 'confirmation',
          code: 'confirmation_mismatch',
          message: 'Confirmation must be "CHANGE SENSITIVE DETAIL pii".',
        },
      ]);
    }
    arrange(null);
    expect((await call(app, 'PATCH', path, body)).status).toBe(404);
    arrange(destinationRow({ critical_allowed: 0 }));
    const critical = await call(app, 'PATCH', path, body);
    expect(critical.body.details.fields[0].code).toBe('critical_not_allowed');
    arrange(destinationRow(), false);
    const unassigned = await call(app, 'PATCH', path, body);
    expect(unassigned.status).toBe(400);
    expect(repoFakes.updateSensitiveDetailPolicy).not.toHaveBeenCalled();
  });

  it('updates the policy after step-up and audits the previous assignment', async () => {
    arrange();
    repoFakes.updateSensitiveDetailPolicy.mockResolvedValue({
      id: 'ldo_1',
      version: 6,
      previous: { destination_id: 'dest_old', enabled: 1, version: 5 },
    });
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    expect((await call(createPlatformApp(POLICY_UPDATE), 'PATCH', path, body)).status).toBe(401);
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'webhook.destination.update',
      targetTenantId: 'tenant-a',
      targetIds: ['dest_1'],
      params: {
        kind: 'logging.sensitive_detail_policy.update',
        log_type: 'pii',
        plane: 'sensitive_detail',
        destination_id: 'dest_1',
        enabled: true,
      },
    });
    expect(repoFakes.updateSensitiveDetailPolicy).not.toHaveBeenCalled();
    const res = await call(createPlatformApp(POLICY_UPDATE), 'PATCH', path, body);
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({
      id: 'ldo_1',
      tenant_id: null,
      log_type: 'pii',
      plane: 'sensitive_detail',
      destination_id: 'dest_1',
      enabled: 1,
      managed_by: 'platform',
      version: 6,
      updated_at: NOW,
    });
    expect(res.body.version).toBe(6);
    expect(repoFakes.updateSensitiveDetailPolicy).toHaveBeenCalledWith({
      logType: 'pii',
      destinationId: 'dest_1',
      enabled: true,
      actorId: 'admin-1',
      now: NOW,
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.sensitive_detail_policy.update',
        resourceType: 'logging_destination_override',
        resourceId: 'ldo_1',
        severity: 'warn',
        before: { destination_id: 'dest_old', enabled: true, version: 5 },
        after: {
          log_type: 'pii',
          plane: 'sensitive_detail',
          destination_id: 'dest_1',
          enabled: true,
          version: 6,
        },
      })
    );
  });

  it('disables only on an explicit false and tolerates a missing previous assignment', async () => {
    arrange();
    repoFakes.updateSensitiveDetailPolicy.mockResolvedValue({
      id: 'ldo_1',
      version: 1,
      previous: null,
    });
    const off = await call(createPlatformApp(POLICY_UPDATE), 'PATCH', path, {
      ...body,
      enabled: false,
    });
    expect(off.body.item.enabled).toBe(0);
    expect(repoFakes.updateSensitiveDetailPolicy.mock.calls[0][0].enabled).toBe(false);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        before: undefined,
        after: expect.objectContaining({ enabled: false }),
      })
    );
    for (const enabled of [undefined, true, 'false', 0]) {
      repoFakes.updateSensitiveDetailPolicy.mockClear();
      await call(createPlatformApp(POLICY_UPDATE), 'PATCH', path, { ...body, enabled });
      expect(repoFakes.updateSensitiveDetailPolicy.mock.calls[0][0].enabled).toBe(true);
    }
    repoFakes.updateSensitiveDetailPolicy.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(POLICY_UPDATE), 'PATCH', path, body)).status).toBe(500);
  });
});
