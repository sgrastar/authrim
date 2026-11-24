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

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  coreFakes.resolveTenantProfiles.mockResolvedValue({ residencyProfile: null });
});
afterEach(() => vi.useRealTimers());

function overrideRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ov_1',
    tenant_id: null,
    log_type: 'normal',
    plane: 'primary',
    destination_id: 'dest_0',
    fallback_policy_id: null,
    enabled: 1,
    managed_by: 'platform',
    change_protection: 'confirm',
    approval_policy_id: null,
    policy_hash: 'sha256:old',
    created_by: 'a',
    updated_by: 'a',
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
    default_fallback_eligible: 0,
    version: 1,
    ...overrides,
  };
}

function arrange(input: {
  current?: Record<string, unknown> | null;
  destination?: Record<string, unknown> | null;
  previous?: Record<string, unknown> | null;
}) {
  mockAdapter.queryOne.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('FROM logging_destination_override_history')) return input.previous ?? null;
    if (text.includes('FROM logging_destination_overrides'))
      return input.current === undefined ? overrideRow() : input.current;
    if (text.includes('FROM admin_destinations'))
      return input.destination === undefined ? destinationRow() : input.destination;
    if (text.includes('storage_destination_assignments')) return { id: 'sda_1' };
    return null;
  });
}

const body = { log_type: 'normal', plane: 'primary', destination_id: 'dest_1' };
const patchPaths = [`${POLICIES}/rows/ov_1`, `${POLICIES}/ov_1`];

describe('PATCH override (rows/:rowId and /:policy_id)', () => {
  const app = () => createPlatformApp([PLATFORM]);

  it('reports invalid body fields', async () => {
    for (const path of patchPaths) {
      const res = await call(
        app(),
        'PATCH',
        path,
        { log_type: 'nope', plane: 'nope', expected_version: 'x' },
        { 'if-match': 'bad' }
      );
      expect(res.status).toBe(400);
      expect(res.body.details.fields.map((f: { path: string }) => f.path)).toEqual([
        'log_type',
        'plane',
        'destination_id',
        'expected_version',
        'If-Match',
      ]);
    }
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('answers 404, refuses foreign rows and requires the matching permission', async () => {
    arrange({ current: null });
    expect((await call(app(), 'PATCH', patchPaths[0], body)).status).toBe(404);
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['ov_1']);
    arrange({});
    const tenantAdmin = await call(createApp([TENANT]), 'PATCH', patchPaths[0], body);
    expect(tenantAdmin.status).toBe(403);
    expect(tenantAdmin.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    const noPermission = await call(createPlatformApp([TENANT]), 'PATCH', patchPaths[0], body);
    expect(noPermission.status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('answers 409 for a stale version', async () => {
    arrange({});
    const res = await call(app(), 'PATCH', patchPaths[1], { ...body, expected_version: 9 });
    expect(res.status).toBe(409);
    expect(res.body.details.conflict).toEqual({ expected_version: 9, actual_version: 2 });
    expect((await call(app(), 'PATCH', patchPaths[1], body, { 'if-match': 'v1' })).status).toBe(
      409
    );
  });

  it('rejects an ineligible destination', async () => {
    arrange({ destination: null });
    expect((await call(app(), 'PATCH', patchPaths[0], body)).status).toBe(404);
    arrange({ destination: destinationRow({ health_status: 'unreachable' }) });
    const unhealthy = await call(app(), 'PATCH', patchPaths[0], body);
    expect(unhealthy.body.details.fields[0]).toMatchObject({
      path: 'destination_id',
      code: 'destination_unhealthy',
    });
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('updates a platform override after step-up, recording history and a new policy hash', async () => {
    arrange({});
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    expect((await call(app(), 'PATCH', patchPaths[0], body)).status).toBe(401);
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'webhook.destination.update',
      targetTenantId: 'tenant-a',
      targetIds: ['ov_1'],
      params: {
        kind: 'logging.assignment.update',
        tenant_id: null,
        log_type: 'normal',
        plane: 'primary',
        destination_id: 'dest_1',
        fallback_policy_id: null,
        enabled: true,
      },
    });
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    const res = await call(app(), 'PATCH', patchPaths[0], {
      ...body,
      enabled: false,
      change_protection: 'approval_required',
      approval_policy_id: 'ap_1',
    });
    expect(res.status).toBe(200);
    const hash = res.body.item.policy_hash as string;
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(res.body.item).toEqual({
      id: 'ov_1',
      tenant_id: null,
      log_type: 'normal',
      plane: 'primary',
      destination_id: 'dest_1',
      fallback_policy_id: null,
      enabled: 0,
      managed_by: 'platform',
      change_protection: 'approval_required',
      approval_policy_id: 'ap_1',
      policy_hash: hash,
      version: 3,
      updated_at: NOW,
    });
    const executed = mockAdapter.execute.mock.calls as Array<[string, unknown[]]>;
    expect(executed[0][1]).toEqual([
      null,
      'normal',
      'primary',
      'dest_1',
      null,
      0,
      'platform',
      'approval_required',
      'ap_1',
      hash,
      'admin-1',
      NOW,
      'ov_1',
      2,
    ]);
    expect(executed[1][0]).toContain('INSERT INTO logging_destination_override_history');
    const history = executed[1][1];
    expect(history.slice(1, 5)).toEqual(['ov_1', null, 'normal', 'primary']);
    expect(history.slice(5, 7)).toEqual(['dest_0', 'dest_1']);
    expect(history.slice(9, 11)).toEqual([1, 0]);
    expect(history.slice(17, 19)).toEqual([2, 3]);
    expect(history.slice(19, 22)).toEqual(['admin-1', NOW, 'update']);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_destination_override.update',
        resourceType: 'logging_destination_override',
        resourceId: 'ov_1',
        severity: 'info',
        before: expect.objectContaining({
          destination_id: 'dest_0',
          enabled: true,
          managed_by: 'platform',
          version: 2,
        }),
        after: expect.objectContaining({
          destination_id: 'dest_1',
          enabled: false,
          managed_by: 'platform',
          version: 3,
        }),
      })
    );
  });

  it('only gates changes that affect delivery', async () => {
    arrange({ current: overrideRow({ destination_id: 'dest_1' }) });
    const same = await call(app(), 'PATCH', patchPaths[0], {
      ...body,
      change_protection: 'config_only',
    });
    expect(same.status).toBe(200);
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
    expect(same.body.item.change_protection).toBe('config_only');
    const inherited = await call(app(), 'PATCH', patchPaths[0], body);
    expect(inherited.body.item.change_protection).toBe('confirm');
    const variants: Array<Record<string, unknown>> = [
      { fallback_policy_id: 'fb_1' },
      { enabled: false },
    ];
    for (const variant of variants) {
      stepUpFakes.requireAdminStepUp.mockClear();
      await call(app(), 'PATCH', patchPaths[0], { ...body, ...variant });
      expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledTimes(1);
    }
    arrange({ current: overrideRow({ destination_id: 'dest_1', log_type: 'job' }) });
    stepUpFakes.requireAdminStepUp.mockClear();
    await call(app(), 'PATCH', patchPaths[0], body);
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledTimes(1);
  });

  it('manages tenant overrides as tenant-managed and keeps the stored tenant on update', async () => {
    arrange({
      current: overrideRow({ tenant_id: 'tenant-a', log_type: 'job', managed_by: 'tenant' }),
    });
    const jobBody = { ...body, log_type: 'job' };
    const res = await call(createApp([TENANT]), 'PATCH', patchPaths[0], jobBody);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ tenant_id: 'tenant-a', managed_by: 'tenant' });
    expect(stepUpFakes.requireAdminStepUp.mock.calls[0][1].targetTenantId).toBe('tenant-a');
    const own = await call(createApp([TENANT]), 'PATCH', patchPaths[0], {
      ...jobBody,
      tenant_id: 'tenant-b',
    });
    expect(own.status).toBe(403);
    arrange({ current: overrideRow({ tenant_id: 'tenant-b', log_type: 'job' }) });
    expect((await call(createApp([TENANT]), 'PATCH', patchPaths[0], jobBody)).status).toBe(403);
  });

  it('answers 409 on a lost race, warns for critical policies and fails with 500 on errors', async () => {
    arrange({});
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
    const raced = await call(app(), 'PATCH', patchPaths[0], body);
    expect(raced.status).toBe(409);
    expect(raced.body.details.conflict).toEqual({ reason: 'concurrent_modification' });
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
    arrange({ current: overrideRow({ log_type: 'audit', plane: 'archive' }) });
    const critical = {
      ...body,
      log_type: 'audit',
      plane: 'archive',
      confirmation: 'CHANGE CRITICAL LOGGING audit:archive',
    };
    expect(
      (await call(createPlatformApp([PLATFORM, CRITICAL]), 'PATCH', patchPaths[0], critical)).status
    ).toBe(200);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    expect((await call(app(), 'PATCH', patchPaths[0], body)).status).toBe(500);
  });
});

describe('POST override rollback', () => {
  const paths = [`${POLICIES}/rows/ov_1/rollback`, `${POLICIES}/overrides/ov_1/rollback`];
  const app = () => createPlatformApp([PLATFORM]);
  const previous = (overrides: Record<string, unknown> = {}) => ({
    previous_destination_id: 'dest_prev',
    previous_fallback_policy_id: 'fb_prev',
    previous_enabled: 0,
    previous_change_protection: 'approval_required',
    previous_approval_policy_id: 'ap_prev',
    previous_policy_hash: 'sha256:prev',
    previous_version: 1,
    ...overrides,
  });

  it('answers 404, refuses foreign rows and requires the permission', async () => {
    arrange({ current: null });
    for (const path of paths) expect((await call(app(), 'POST', path, {})).status).toBe(404);
    arrange({});
    expect((await call(createApp([TENANT]), 'POST', paths[0], {})).status).toBe(403);
    expect((await call(createPlatformApp([TENANT]), 'POST', paths[0], {})).status).toBe(403);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('answers 409 when no previous state is recorded', async () => {
    for (const prior of [
      null,
      previous({ previous_destination_id: null }),
      previous({ previous_enabled: null }),
    ]) {
      arrange({ previous: prior });
      const res = await call(app(), 'POST', paths[0], {});
      expect(res.status).toBe(409);
      expect(res.body.details.conflict).toEqual({ reason: 'rollback_state_not_available' });
    }
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('restores the previous assignment after step-up and records a rollback history entry', async () => {
    arrange({ previous: previous() });
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    expect((await call(app(), 'POST', paths[1], {})).status).toBe(401);
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'webhook.destination.update',
      targetTenantId: 'tenant-a',
      targetIds: ['ov_1'],
      params: {
        kind: 'logging.assignment.rollback',
        tenant_id: null,
        log_type: 'normal',
        plane: 'primary',
        destination_id: 'dest_prev',
        fallback_policy_id: 'fb_prev',
        enabled: false,
      },
    });
    const res = await call(app(), 'POST', paths[1], {});
    expect(res.status).toBe(200);
    const hash = res.body.item.policy_hash as string;
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(res.body.item).toEqual({
      id: 'ov_1',
      destination_id: 'dest_prev',
      fallback_policy_id: 'fb_prev',
      enabled: 0,
      change_protection: 'approval_required',
      approval_policy_id: 'ap_prev',
      policy_hash: hash,
      version: 3,
      updated_at: NOW,
    });
    const executed = mockAdapter.execute.mock.calls as Array<[string, unknown[]]>;
    expect(executed[0][1]).toEqual([
      'dest_prev',
      'fb_prev',
      0,
      'approval_required',
      'ap_prev',
      hash,
      'admin-1',
      NOW,
      'ov_1',
      2,
    ]);
    const history = executed[1][1];
    expect(history.slice(5, 7)).toEqual(['dest_0', 'dest_prev']);
    expect(history.slice(17, 19)).toEqual([2, 3]);
    expect(history[21]).toBe('rollback');
    expect(JSON.parse(history[22] as string)).toEqual({ restored_previous_version: 1 });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'logging_destination_override.rollback',
        resourceId: 'ov_1',
        severity: 'info',
        before: expect.objectContaining({ id: 'ov_1', destination_id: 'dest_0' }),
        after: expect.objectContaining({ destination_id: 'dest_prev', enabled: 0, version: 3 }),
      })
    );
  });

  it('skips step-up when the delivery state already matches and falls back to the current protection', async () => {
    arrange({
      current: overrideRow({
        destination_id: 'dest_prev',
        fallback_policy_id: 'fb_prev',
        enabled: 0,
      }),
      previous: previous({ previous_change_protection: null }),
    });
    const res = await call(app(), 'POST', paths[0], {});
    expect(res.status).toBe(200);
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
    expect(res.body.item.change_protection).toBe('confirm');
    for (const override of [
      { destination_id: 'other' },
      { fallback_policy_id: null },
      { enabled: 1 },
    ]) {
      stepUpFakes.requireAdminStepUp.mockClear();
      arrange({
        current: overrideRow({
          destination_id: 'dest_prev',
          fallback_policy_id: 'fb_prev',
          enabled: 0,
          ...override,
        }),
        previous: previous(),
      });
      await call(app(), 'POST', paths[0], {});
      expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledTimes(1);
    }
  });

  it('honours the critical confirmation, answers 409 on a lost race and 500 on errors', async () => {
    arrange({
      current: overrideRow({ log_type: 'audit', plane: 'archive' }),
      previous: previous(),
    });
    const critical = createPlatformApp([PLATFORM, CRITICAL]);
    const noConfirm = await call(critical, 'POST', paths[0], {});
    expect(noConfirm.body.details.fields[0].code).toBe('confirmation_mismatch');
    const ok = await call(critical, 'POST', paths[0], {
      confirmation: ' CHANGE CRITICAL LOGGING audit:archive ',
    });
    expect(ok.status).toBe(200);
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'warn' })
    );
    arrange({ previous: previous() });
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
    const raced = await call(app(), 'POST', paths[0], {});
    expect(raced.status).toBe(409);
    expect(raced.body.details.conflict).toEqual({ reason: 'concurrent_modification' });
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect((await call(app(), 'POST', paths[0], {})).status).toBe(500);
  });
});
