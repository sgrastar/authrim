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
vi.mock('@authrim/ar-lib-logging/keys', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildKeysMock(
    await importOriginal<typeof import('@authrim/ar-lib-logging/keys')>()
  )
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { mockAdapter, resetFakes } from './logging-control-b-harness';
import { ADMIN_LOGGING, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const POLICY_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ];
const REPAIR_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ];

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('GET /coverage', () => {
  it('requires the coverage read permission', async () => {
    expect((await call(createApp([]), 'GET', `${ADMIN_LOGGING}/coverage`)).status).toBe(403);
    const res = await call(
      createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_READ]),
      'GET',
      `${ADMIN_LOGGING}/coverage`
    );
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.total).toBe(res.body.items.length);
  });
});

describe('GET /key-registry', () => {
  const path = `${ADMIN_LOGGING}/key-registry`;

  it('requires the policy read permission and platform authority', async () => {
    expect((await call(createPlatformApp([]), 'GET', path)).status).toBe(403);
    const tenant = await call(createApp(POLICY_READ), 'GET', path);
    expect(tenant.status).toBe(403);
    expect(tenant.body.details.permission).toEqual({
      required_scope: 'platform',
      reason: 'platform_authority_required',
    });
    expect(mockAdapter.query).not.toHaveBeenCalled();
  });

  it('maps registry rows with numeric coercion and default limit 100 (max 500)', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'kr_1',
        tenant_key: 'tk_a',
        surface: 'admin',
        log_type: 'audit',
        plane: 'archive',
        active_version: '3',
        registry_status: 'active',
        last_rotated_at: '1700',
        registry_created_at: '10',
        registry_updated_at: 20,
        version: '2',
        backend_ref: 'kms://k',
        version_status: 'rewrap_required',
        usage_count: '7',
        stale_count: 4,
        version_created_at: '30',
        retired_at: null,
      },
      {
        id: 'kr_2',
        tenant_key: 'tk_b',
        surface: null,
        log_type: 'normal',
        plane: 'primary',
        active_version: 1,
        registry_status: 'active',
        last_rotated_at: null,
        registry_created_at: 1,
        registry_updated_at: 2,
        version: null,
        backend_ref: null,
        version_status: null,
        usage_count: null,
        stale_count: undefined,
        version_created_at: '',
        retired_at: '55',
      },
    ]);
    const res = await call(createPlatformApp(POLICY_READ), 'GET', path);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([100]);
    expect(mockAdapter.query.mock.calls[0][0]).toContain(
      'ORDER BY kr.tenant_key ASC, kr.log_type ASC, kr.plane ASC, kv.version DESC'
    );
    expect(res.body.items).toEqual([
      {
        id: 'kr_1',
        tenant_key: 'tk_a',
        surface: 'admin',
        log_type: 'audit',
        plane: 'archive',
        active_version: 3,
        registry_status: 'active',
        last_rotated_at: 1700,
        registry_created_at: 10,
        registry_updated_at: 20,
        version: 2,
        backend_ref: 'kms://k',
        version_status: 'rewrap_required',
        usage_count: 7,
        stale_count: 4,
        version_created_at: 30,
        retired_at: null,
      },
      {
        id: 'kr_2',
        tenant_key: 'tk_b',
        surface: null,
        log_type: 'normal',
        plane: 'primary',
        active_version: 1,
        registry_status: 'active',
        last_rotated_at: null,
        registry_created_at: 1,
        registry_updated_at: 2,
        version: null,
        backend_ref: null,
        version_status: null,
        usage_count: 0,
        stale_count: 0,
        version_created_at: null,
        retired_at: 55,
      },
    ]);
    expect(res.body.total).toBe(2);
    mockAdapter.query.mockClear();
    await call(createPlatformApp(POLICY_READ), 'GET', `${path}?limit=900`);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([500]);
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(POLICY_READ), 'GET', path)).status).toBe(500);
  });
});

describe('GET /key-registry/:id/impact', () => {
  const path = `${ADMIN_LOGGING}/key-registry/kr_1/impact`;

  it('requires the policy read permission and platform authority', async () => {
    expect((await call(createPlatformApp([]), 'GET', path)).status).toBe(403);
    expect((await call(createApp(POLICY_READ), 'GET', path)).status).toBe(403);
    expect((await call(createPlatformApp(POLICY_READ), 'GET', path)).status).toBe(404);
  });

  it('reports the registry, per-version object counts and rewrap job totals', async () => {
    mockAdapter.queryOne.mockResolvedValue({ id: 'kr_1', tenant_key: 'tk_a' });
    mockAdapter.query.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM logging_key_versions')
        ? [{ version: 2, object_count: 4 }]
        : [{ status: 'queued', total: 3 }]
    );
    const res = await call(createPlatformApp(POLICY_READ), 'GET', path);
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({
      registry: { id: 'kr_1', tenant_key: 'tk_a' },
      versions: [{ version: 2, object_count: 4 }],
      rewrap_jobs: [{ status: 'queued', total: 3 }],
      checked_at: NOW,
    });
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['kr_1']);
    const calls = mockAdapter.query.mock.calls as Array<[string, unknown[]]>;
    expect(calls.map(([, params]) => params)).toEqual([['kr_1'], ['kr_1']]);
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(POLICY_READ), 'GET', path)).status).toBe(500);
  });
});

describe('GET /rewrap-jobs', () => {
  const path = `${ADMIN_LOGGING}/rewrap-jobs`;

  it('requires repair read and platform authority', async () => {
    expect((await call(createPlatformApp([]), 'GET', path)).status).toBe(403);
    expect((await call(createApp(REPAIR_READ), 'GET', path)).status).toBe(403);
  });

  it('lists serialized jobs ordered by state with limit 50 (max 200)', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'lrj_1',
        key_registry_id: 'kr_1',
        from_version: 1,
        to_version: 2,
        priority: 5,
        status: 'queued',
        created_at: 1,
        started_at: null,
        completed_at: null,
        metadata: '{}',
      },
    ]);
    const res = await call(createPlatformApp(REPAIR_READ), 'GET', path);
    expect(res.body.items).toEqual([
      expect.objectContaining({ id: 'lrj_1', status: 'queued', priority: 5, metadata: {} }),
    ]);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([50]);
    expect(mockAdapter.query.mock.calls[0][0]).toContain("WHEN 'running' THEN 0");
    mockAdapter.query.mockClear();
    await call(createPlatformApp(REPAIR_READ), 'GET', `${path}?limit=999`);
    expect(mockAdapter.query.mock.calls[0][1]).toEqual([200]);
    mockAdapter.query.mockRejectedValue(new Error('x'));
    expect((await call(createPlatformApp(REPAIR_READ), 'GET', path)).status).toBe(500);
  });
});
