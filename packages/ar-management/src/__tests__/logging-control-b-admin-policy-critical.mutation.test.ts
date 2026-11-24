/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
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
  LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY,
  summarizeAdminAuditCoverage,
} from '@authrim/ar-lib-logging/coverage';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { LogQueryIncompleteError, LogQueryInvalidRequestError } from '../log-archive-query';
import {
  auditWrite,
  mockAdapter,
  readAdapterFakes,
  repoFakes,
  resetFakes,
  stepUpFakes,
} from './logging-control-b-harness';
import { ADMIN_LOGGING, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const OVERVIEW_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ];
const CRITICAL_UPDATE = [ADMIN_PERMISSIONS.ADMIN_LOGGING_CRITICAL_UPDATE];
const POLICY_READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ];

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

describe('critical and sensitive-detail policy reads', () => {
  it('scopes the critical policy to the caller tenant unless platform', async () => {
    const path = `${ADMIN_LOGGING}/critical-policy`;
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    repoFakes.loadCriticalPolicy.mockResolvedValue({ summary: { total: 1 } });
    const tenant = await call(createApp(OVERVIEW_READ), 'GET', path);
    expect(tenant.body.item).toEqual({ summary: { total: 1 } });
    expect(repoFakes.loadCriticalPolicy).toHaveBeenLastCalledWith('tenant-a');
    await call(createPlatformApp(OVERVIEW_READ), 'GET', path);
    expect(repoFakes.loadCriticalPolicy).toHaveBeenLastCalledWith(undefined);
    repoFakes.loadCriticalPolicy.mockRejectedValue(new Error('x'));
    expect((await call(createApp(OVERVIEW_READ), 'GET', path)).status).toBe(500);
  });

  it('scopes the sensitive-detail policy to the caller tenant unless platform', async () => {
    const path = `${ADMIN_LOGGING}/sensitive-detail-policy`;
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    repoFakes.loadSensitiveDetailPolicy.mockResolvedValue({ summary: { enabled: true } });
    const tenant = await call(createApp(POLICY_READ), 'GET', path);
    expect(tenant.body.item).toEqual({ summary: { enabled: true } });
    expect(repoFakes.loadSensitiveDetailPolicy).toHaveBeenLastCalledWith('tenant-a');
    await call(createPlatformApp(POLICY_READ), 'GET', path);
    expect(repoFakes.loadSensitiveDetailPolicy).toHaveBeenLastCalledWith(undefined);
    repoFakes.loadSensitiveDetailPolicy.mockRejectedValue(new Error('x'));
    expect((await call(createApp(POLICY_READ), 'GET', path)).status).toBe(500);
  });
});

describe('PATCH /critical-policy', () => {
  const path = `${ADMIN_LOGGING}/critical-policy`;
  const confirmation = 'UPDATE CRITICAL LOGGING archive';

  it('requires the critical update permission and a destination id', async () => {
    expect((await call(createApp(OVERVIEW_READ), 'PATCH', path, {})).status).toBe(403);
    const res = await call(createApp(CRITICAL_UPDATE), 'PATCH', path, { destination_id: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'destination_id', code: 'required', message: 'Destination id is required.' },
    ]);
  });

  it('answers 404 for an unknown destination and demands the exact confirmation', async () => {
    expect(
      (await call(createApp(CRITICAL_UPDATE), 'PATCH', path, { destination_id: 'dest_1' })).status
    ).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['dest_1']);
    mockAdapter.queryOne.mockResolvedValue(destinationRow());
    for (const body of [{}, { confirmation: 'UPDATE CRITICAL LOGGING other' }]) {
      const res = await call(createApp(CRITICAL_UPDATE), 'PATCH', path, {
        destination_id: 'dest_1',
        ...body,
      });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'confirmation',
          code: 'confirmation_mismatch',
          message: `Confirmation must be "${confirmation}".`,
        },
      ]);
    }
    expect(repoFakes.updateCriticalPolicy).not.toHaveBeenCalled();
  });

  it('updates the policy after step-up and audits before and after', async () => {
    mockAdapter.queryOne.mockResolvedValue(
      destinationRow({ default_fallback_eligible: 1, critical_allowed: 0 })
    );
    repoFakes.updateCriticalPolicy.mockResolvedValue({ version: 4 });
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    const body = { destination_id: 'dest_1', confirmation };
    expect((await call(createApp(CRITICAL_UPDATE), 'PATCH', path, body)).status).toBe(401);
    expect(repoFakes.updateCriticalPolicy).not.toHaveBeenCalled();
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'webhook.destination.update',
      targetTenantId: 'tenant-a',
      targetIds: ['dest_1'],
      params: {
        kind: 'logging.critical_policy.update',
        provider: 'r2',
        critical_allowed: true,
        default_fallback_eligible: true,
      },
    });
    const res = await call(createApp(CRITICAL_UPDATE), 'PATCH', path, body);
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({
      id: 'dest_1',
      critical_allowed: 1,
      default_fallback_eligible: 1,
      version: 4,
      updated_at: NOW,
    });
    expect(res.body.version).toBe(4);
    expect(res.body.audit_id).toBe('audit-id-1');
    expect(repoFakes.updateCriticalPolicy).toHaveBeenCalledWith({
      destinationId: 'dest_1',
      criticalAllowed: true,
      defaultFallbackEligible: true,
      actorId: 'admin-1',
      now: NOW,
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.critical_policy.update',
        resourceType: 'admin_destination',
        resourceId: 'dest_1',
        severity: 'critical',
        before: { critical_allowed: false, default_fallback_eligible: true, version: 3 },
        after: { critical_allowed: true, default_fallback_eligible: true, version: 4 },
      })
    );
  });

  it('honours explicit booleans, ignores other types and binds tenant destinations to their tenant', async () => {
    mockAdapter.queryOne.mockResolvedValue(
      destinationRow({ scope_type: 'tenant', scope_id: 'tenant-z', default_fallback_eligible: 1 })
    );
    repoFakes.updateCriticalPolicy.mockResolvedValue({ version: 5 });
    const res = await call(createPlatformApp(CRITICAL_UPDATE), 'PATCH', path, {
      destination_id: 'dest_1',
      confirmation,
      critical_allowed: false,
      default_fallback_eligible: false,
    });
    expect(res.body.item).toMatchObject({
      critical_allowed: 0,
      default_fallback_eligible: 0,
      version: 5,
    });
    expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1].targetTenantId).toBe('tenant-z');
    expect(repoFakes.updateCriticalPolicy.mock.calls[0][0]).toMatchObject({
      criticalAllowed: false,
      defaultFallbackEligible: false,
    });
    await call(createPlatformApp(CRITICAL_UPDATE), 'PATCH', path, {
      destination_id: 'dest_1',
      confirmation,
      critical_allowed: 'no',
      default_fallback_eligible: 'no',
    });
    expect(repoFakes.updateCriticalPolicy.mock.calls[1][0]).toMatchObject({
      criticalAllowed: true,
      defaultFallbackEligible: true,
    });
    repoFakes.updateCriticalPolicy.mockRejectedValue(new Error('x'));
    expect(
      (
        await call(createPlatformApp(CRITICAL_UPDATE), 'PATCH', path, {
          destination_id: 'dest_1',
          confirmation,
        })
      ).status
    ).toBe(500);
  });
});

describe('POST /coverage/check and GET /', () => {
  it('upserts the coverage registry and reports its summary', async () => {
    const path = `${ADMIN_LOGGING}/coverage/check`;
    expect((await call(createApp(OVERVIEW_READ), 'POST', path)).status).toBe(403);
    const res = await call(
      createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_UPDATE]),
      'POST',
      path
    );
    expect(res.status).toBe(200);
    const summary = summarizeAdminAuditCoverage(LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY, NOW);
    expect(res.body.result).toEqual({
      checked_at: NOW,
      updated_count: LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY.length,
      summary,
    });
    const rows = repoFakes.upsertCoverageStatuses.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY.length);
    expect(rows[0]).toMatchObject({ first_seen_at: NOW, last_seen_at: NOW, updated_at: NOW });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.coverage.check',
        resourceType: 'admin_audit_coverage_status',
        resourceId: 'logging-admin-audit-coverage',
        severity: summary.gap_detected > 0 ? 'warn' : 'info',
        metadata: { checked_at: NOW, updated_count: rows.length, summary },
      })
    );
    repoFakes.upsertCoverageStatuses.mockRejectedValue(new Error('x'));
    expect(
      (await call(createApp([ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_UPDATE]), 'POST', path))
        .status
    ).toBe(500);
  });

  describe('overview', () => {
    it('requires overview read', async () => {
      expect((await call(createApp([]), 'GET', `${ADMIN_LOGGING}`)).status).toBe(403);
    });

    it('summarizes audit, archive, delivery, recent changes and policies for the caller tenant', async () => {
      repoFakes.loadCriticalPolicy.mockResolvedValue({ summary: { critical: 'c' } });
      repoFakes.loadSensitiveDetailPolicy.mockResolvedValue({ summary: { sensitive: 's' } });
      readAdapterFakes.queryOne.mockResolvedValue({ total: '12', failures: 3, critical: '1' });
      readAdapterFakes.query.mockResolvedValue([{ audit_id: 'a1' }]);
      readAdapterFakes.hasArchive.mockReturnValue(true);
      readAdapterFakes.coverage.mockReturnValue({ complete: false });
      mockAdapter.query.mockResolvedValue([{ lane: 'critical', status: 'sent', total: 4 }]);
      const res = await call(createApp(OVERVIEW_READ), 'GET', `${ADMIN_LOGGING}?time_start=5000`);
      expect(res.status).toBe(200);
      const key = await deriveTenantKeyFromTenantId('tenant-a', undefined);
      expect(res.body.item).toEqual({
        tenant_id: 'tenant-a',
        window_start_at: 5000,
        coverage: summarizeAdminAuditCoverage(LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY),
        critical_protection: { critical: 'c' },
        sensitive_detail: { sensitive: 's' },
        audit: { total: 12, failures: 3, critical: 1 },
        recent_changes: [{ audit_id: 'a1' }],
        archive: { format: 'iceberg', has_archive: true, coverage: { complete: false } },
        delivery: [{ lane: 'critical', status: 'sent', total: 4 }],
      });
      expect(readAdapterFakes.createLogReadAdapter).toHaveBeenCalledWith({
        env: expect.anything(),
        tenantId: 'tenant-a',
        dataset: 'admin.admin_audit_log',
        window: { fromMs: 5000 },
        onCoverage: expect.any(Function),
      });
      expect(readAdapterFakes.queryOne.mock.calls[0][1]).toEqual(['tenant-a', 5000]);
      expect(readAdapterFakes.query.mock.calls[0][1]).toEqual(['tenant-a', 5000]);
      const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE bucket_start_at >= ? AND tenant_key = ?');
      expect(params).toEqual([5000, key]);
      expect(repoFakes.loadCriticalPolicy).toHaveBeenCalledWith('tenant-a');
    });

    it('answers 500 when the policy summaries cannot be loaded', async () => {
      const res = await call(createPlatformApp(OVERVIEW_READ), 'GET', ADMIN_LOGGING);
      expect(res.status).toBe(500);
    });

    it('treats an empty audit summary as zeros', async () => {
      repoFakes.loadCriticalPolicy.mockResolvedValue({ summary: {} });
      repoFakes.loadSensitiveDetailPolicy.mockResolvedValue({ summary: {} });
      readAdapterFakes.queryOne.mockResolvedValue(null);
      const res = await call(createPlatformApp(OVERVIEW_READ), 'GET', ADMIN_LOGGING);
      expect(res.body.item.audit).toEqual({ total: 0, failures: 0, critical: 0 });
      expect(res.body.item.window_start_at).toBe(NOW - 24 * 3600 * 1000);
      const [sql, params] = mockAdapter.query.mock.calls[0] as [string, unknown[]];
      expect(sql).not.toContain('tenant_key = ?');
      expect(params).toEqual([NOW - 24 * 3600 * 1000]);
      expect(readAdapterFakes.createLogReadAdapter.mock.calls[0][0].window).toEqual({
        fromMs: NOW - 24 * 3600 * 1000,
      });
      expect(repoFakes.loadCriticalPolicy).toHaveBeenCalledWith(undefined);
    });

    it('maps log query failures to their own responses and anything else to 500', async () => {
      repoFakes.loadCriticalPolicy.mockResolvedValue({ summary: {} });
      repoFakes.loadSensitiveDetailPolicy.mockResolvedValue({ summary: {} });
      readAdapterFakes.queryOne.mockRejectedValue(new LogQueryIncompleteError());
      const incomplete = await call(createApp(OVERVIEW_READ), 'GET', ADMIN_LOGGING);
      expect(incomplete.status).toBe(503);
      expect(incomplete.body).toMatchObject({ error: 'log_query_incomplete', complete: false });
      readAdapterFakes.queryOne.mockRejectedValue(new LogQueryInvalidRequestError('bad window'));
      const invalid = await call(createApp(OVERVIEW_READ), 'GET', ADMIN_LOGGING);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error_description).toBe('bad window');
      readAdapterFakes.queryOne.mockRejectedValue(new Error('x'));
      expect((await call(createApp(OVERVIEW_READ), 'GET', ADMIN_LOGGING)).status).toBe(500);
    });
  });
});
