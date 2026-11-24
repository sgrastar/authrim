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
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import {
  auditWrite,
  coreFakes,
  mockAdapter,
  resetFakes,
  stepUpFakes,
} from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const PLATFORM = ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE;
const TENANT = ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE;
const CRITICAL = ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE;
const PATH = `${POLICIES}/fallbacks/fb_1`;

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  coreFakes.resolveTenantProfiles.mockResolvedValue({ residencyProfile: null });
});
afterEach(() => vi.useRealTimers());

function fallbackRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fb_1',
    scope_type: 'platform',
    scope_id: 'global',
    log_type: 'normal',
    plane: 'primary',
    fallback_destination_id: null,
    failure_mode: 'platform_default',
    created_at: 1,
    updated_at: 2,
    version: 2,
    ...overrides,
  };
}

function destinationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dest_1',
    scope_type: 'platform',
    scope_id: 'global',
    lifecycle_status: 'active',
    health_status: 'healthy',
    provider_config: '{}',
    region: null,
    critical_allowed: 1,
    default_fallback_eligible: 1,
    version: 1,
    ...overrides,
  };
}

function arrange(input: {
  current?: Record<string, unknown> | null;
  destination?: Record<string, unknown> | null;
  assigned?: boolean;
  duplicate?: { id: string } | null;
}) {
  mockAdapter.queryOne.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('SELECT id FROM logging_fallback_policies')) return input.duplicate ?? null;
    if (text.includes('FROM logging_fallback_policies'))
      return input.current === undefined ? fallbackRow() : input.current;
    if (text.includes('FROM admin_destinations'))
      return input.destination === undefined ? destinationRow() : input.destination;
    if (text.includes('storage_destination_assignments'))
      return input.assigned === false ? null : { id: 'sda_1' };
    return null;
  });
}

const validBody = {
  scope_type: 'platform',
  log_type: 'normal',
  plane: 'primary',
  failure_mode: 'retry_then_dlq',
};

describe('PATCH /fallbacks/:fallback_id', () => {
  const app = () => createPlatformApp([PLATFORM]);

  it('reports invalid body fields including the If-Match header', async () => {
    const res = await call(
      app(),
      'PATCH',
      PATH,
      {
        log_type: 'nope',
        plane: 'nope',
        failure_mode: 'nope',
        expected_version: -1,
      },
      { 'if-match': 'garbage' }
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'log_type', code: 'invalid_value', message: 'Log type is not supported.' },
      { path: 'plane', code: 'invalid_value', message: 'Log plane is not supported.' },
      {
        path: 'failure_mode',
        code: 'invalid_value',
        message: 'Fallback failure mode is not supported.',
      },
      {
        path: 'expected_version',
        code: 'invalid_value',
        message: 'Expected version must be a positive integer.',
      },
      { path: 'If-Match', code: 'invalid_value', message: 'If-Match must contain a version ETag.' },
    ]);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown fallback and refuses non-owners', async () => {
    arrange({ current: null });
    expect((await call(app(), 'PATCH', PATH, validBody)).status).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['fb_1']);
    arrange({});
    const foreign = await call(createApp([TENANT]), 'PATCH', PATH, {
      ...validBody,
      scope_type: 'tenant',
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    const noPermission = await call(createPlatformApp([TENANT]), 'PATCH', PATH, validBody);
    expect(noPermission.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('answers 409 with both versions when the ETag or expected_version is stale', async () => {
    arrange({});
    const byHeader = await call(app(), 'PATCH', PATH, validBody, { 'if-match': '"v1"' });
    expect(byHeader.status).toBe(409);
    expect(byHeader.body.details.conflict).toEqual({ expected_version: 1, actual_version: 2 });
    const byBody = await call(app(), 'PATCH', PATH, { ...validBody, expected_version: 5 });
    expect(byBody.body.details.conflict).toEqual({ expected_version: 5, actual_version: 2 });
    const matching = await call(app(), 'PATCH', PATH, { ...validBody, expected_version: 2 });
    expect(matching.status).toBe(200);
    const weak = await call(app(), 'PATCH', PATH, validBody, { 'if-match': 'W/"v2"' });
    expect(weak.status).toBe(200);
  });

  it('validates the fallback destination', async () => {
    const body = { ...validBody, fallback_destination_id: 'dest_1' };
    arrange({ destination: null });
    expect((await call(app(), 'PATCH', PATH, body)).status).toBe(404);
    arrange({ destination: destinationRow({ default_fallback_eligible: 0 }) });
    const notEligible = await call(app(), 'PATCH', PATH, body);
    expect(notEligible.status).toBe(400);
    expect(notEligible.body.details.fields).toEqual([
      {
        path: 'fallback_destination_id',
        code: 'fallback_not_allowed',
        message: 'Destination is not approved as a fallback target.',
      },
    ]);
    arrange({ destination: destinationRow({ lifecycle_status: 'disabled' }) });
    const inactive = await call(app(), 'PATCH', PATH, body);
    expect(inactive.body.details.fields[0]).toMatchObject({
      path: 'fallback_destination_id',
      code: 'destination_inactive',
    });
    arrange({ assigned: false });
    expect((await call(app(), 'PATCH', PATH, body)).body.details.fields[0].path).toBe(
      'fallback_destination_id'
    );
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('gates a changed fallback with step-up, then updates it and audits the change', async () => {
    arrange({});
    const body = { ...validBody, fallback_destination_id: 'dest_1' };
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    expect((await call(app(), 'PATCH', PATH, body)).status).toBe(401);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'webhook.destination.update',
      targetTenantId: 'tenant-a',
      targetIds: ['fb_1'],
      params: {
        kind: 'logging.fallback.update',
        scope_type: 'platform',
        scope_id: 'global',
        log_type: 'normal',
        plane: 'primary',
        fallback_destination_id: 'dest_1',
        failure_mode: 'retry_then_dlq',
      },
    });
    const res = await call(app(), 'PATCH', PATH, body);
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({
      id: 'fb_1',
      scope_type: 'platform',
      scope_id: 'global',
      log_type: 'normal',
      plane: 'primary',
      fallback_destination_id: 'dest_1',
      failure_mode: 'retry_then_dlq',
      version: 3,
      updated_at: NOW,
    });
    const [sql, params] = mockAdapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE id = ? AND version = ?');
    expect(params).toEqual([
      'platform',
      'global',
      'normal',
      'primary',
      'dest_1',
      'retry_then_dlq',
      NOW,
      'fb_1',
      2,
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_fallback_policy.update',
        resourceType: 'logging_fallback_policy',
        resourceId: 'fb_1',
        severity: 'info',
        before: expect.objectContaining({
          fallback_destination_id: null,
          failure_mode: 'platform_default',
          version: 2,
        }),
        after: expect.objectContaining({
          fallback_destination_id: 'dest_1',
          failure_mode: 'retry_then_dlq',
          version: 3,
        }),
      })
    );
  });

  it('skips the gate and the duplicate check when nothing changes, and binds tenant fallbacks to their tenant', async () => {
    arrange({ current: fallbackRow({ failure_mode: 'retry_then_dlq' }) });
    expect((await call(app(), 'PATCH', PATH, validBody)).status).toBe(200);
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
    expect(
      mockAdapter.queryOne.mock.calls.some(([sql]) =>
        String(sql).includes('SELECT id FROM logging_fallback_policies')
      )
    ).toBe(false);
    arrange({
      current: fallbackRow({ scope_type: 'tenant', scope_id: 'tenant-z', log_type: 'job' }),
    });
    const res = await call(createPlatformApp([TENANT]), 'PATCH', PATH, {
      scope_type: 'tenant',
      scope_id: 'tenant-z',
      log_type: 'job',
      plane: 'primary',
      failure_mode: 'drop_non_critical',
    });
    expect(res.status).toBe(200);
    expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1].targetTenantId).toBe('tenant-z');
  });

  it('refuses a move onto a key owned by another fallback', async () => {
    arrange({ duplicate: { id: 'fb_other' } });
    const res = await call(app(), 'PATCH', PATH, validBody);
    expect(res.status).toBe(409);
    expect(res.body.details.conflict).toEqual({ reason: 'fallback_policy_exists' });
    arrange({ duplicate: { id: 'fb_1' } });
    expect((await call(app(), 'PATCH', PATH, validBody)).status).toBe(200);
  });

  it('answers 409 on a lost update race, warns for critical policies and fails with 500 on errors', async () => {
    arrange({});
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
    const raced = await call(app(), 'PATCH', PATH, validBody);
    expect(raced.status).toBe(409);
    expect(raced.body.details.conflict).toEqual({ reason: 'concurrent_modification' });
    mockAdapter.execute.mockResolvedValue(undefined);
    expect((await call(app(), 'PATCH', PATH, validBody)).status).toBe(409);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });

    arrange({ current: fallbackRow({ log_type: 'audit', plane: 'archive' }) });
    const critical = { ...validBody, log_type: 'audit', plane: 'archive' };
    const noConfirm = await call(createPlatformApp([PLATFORM, CRITICAL]), 'PATCH', PATH, critical);
    expect(noConfirm.body.details.fields[0].code).toBe('confirmation_mismatch');
    const ok = await call(createPlatformApp([PLATFORM, CRITICAL]), 'PATCH', PATH, {
      ...critical,
      confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
    });
    expect(ok.status).toBe(200);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect((await call(app(), 'PATCH', PATH, validBody)).status).toBe(500);
  });
});
