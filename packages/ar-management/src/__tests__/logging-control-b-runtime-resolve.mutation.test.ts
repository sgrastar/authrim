/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { ADMIN_PERMISSIONS, AR_ERROR_CODES, type Env } from '@authrim/ar-lib-core';
import { coreFakes, envFixture, resetFakes } from './logging-control-b-harness';
import { POLICIES, call, createApp, createPlatformApp } from './logging-control-b-app';

const READ = [ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ];

describe('runtime/resolve', () => {
  beforeEach(() => resetFakes());
  const path = `${POLICIES}/runtime/resolve`;

  it('requires overview or delivery-events read', async () => {
    const res = await call(createApp([]), 'POST', path, { log_type: 'audit', plane: 'archive' });
    expect(res.status).toBe(403);
    expect(coreFakes.resolveRuntimeTarget).not.toHaveBeenCalled();
    const ok = await call(
      createApp([ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ]),
      'POST',
      path,
      { log_type: 'audit', plane: 'archive' }
    );
    expect(ok.status).toBe(200);
  });

  it('refuses a tenant admin naming another tenant', async () => {
    const res = await call(createApp(READ), 'POST', path, {
      tenant_id: 'tenant-b',
      log_type: 'audit',
      plane: 'archive',
    });
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('tenant_scope_mismatch');
  });

  it('reports each unsupported or missing input as its own field error', async () => {
    const res = await call(createApp(READ), 'POST', path, { log_type: 'nope', plane: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'log_type', code: 'invalid_value', message: 'Log type is not supported.' },
      { path: 'plane', code: 'invalid_value', message: 'Log plane is not supported.' },
    ]);
    const onlyPlane = await call(createApp(READ), 'POST', path, { log_type: 'audit' });
    expect(onlyPlane.body.details.fields).toEqual([
      { path: 'plane', code: 'invalid_value', message: 'Log plane is not supported.' },
    ]);
    const onlyType = await call(createApp(READ), 'POST', path, { plane: 'archive' });
    expect(onlyType.body.details.fields).toEqual([
      { path: 'log_type', code: 'invalid_value', message: 'Log type is not supported.' },
    ]);
    expect(coreFakes.resolveRuntimeTarget).not.toHaveBeenCalled();
  });

  it('requires a tenant id when neither the body nor the context supplies one', async () => {
    const res = await call(
      createPlatformApp(READ),
      'POST',
      path,
      { log_type: 'audit', plane: 'archive' },
      { 'x-test-tenant-id': '' }
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'tenant_id', code: 'required', message: 'Tenant id is required.' },
    ]);
  });

  it('describes a resolved r2 target and whether its bucket binding exists', async () => {
    const resolution = { target: { type: 'r2', bucketRef: 'LOG_ARCHIVE' } };
    coreFakes.resolveRuntimeTarget.mockResolvedValue(resolution);
    const res = await call(createPlatformApp(READ), 'POST', path, {
      tenant_id: 'tenant-z',
      log_type: 'audit',
      plane: 'archive',
      region: ' eu ',
    });
    expect(res.status).toBe(200);
    expect(coreFakes.resolveRuntimeTarget).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-z',
      logType: 'audit',
      plane: 'archive',
      region: 'eu',
    });
    expect(res.body.item).toEqual({
      input: { tenant_id: 'tenant-z', log_type: 'audit', plane: 'archive', region: 'eu' },
      resolved: true,
      resolution,
      target_status: { target_type: 'r2', binding_ref: 'LOG_ARCHIVE', binding_configured: true },
    });

    coreFakes.resolveRuntimeTarget.mockResolvedValue({
      target: { type: 'r2', bucketRef: 'MISSING_BUCKET' },
    });
    const missing = await call(createApp(READ), 'POST', path, {
      log_type: 'audit',
      plane: 'archive',
    });
    expect(missing.body.item.input).toEqual({
      tenant_id: 'tenant-a',
      log_type: 'audit',
      plane: 'archive',
      region: null,
    });
    expect(missing.body.item.target_status).toEqual({
      target_type: 'r2',
      binding_ref: 'MISSING_BUCKET',
      binding_configured: false,
    });
  });

  it('treats a non-bucket target as configured and a null resolution as unresolved', async () => {
    coreFakes.resolveRuntimeTarget.mockResolvedValue({ target: { type: 'queue' } });
    const queue = await call(createApp(READ), 'POST', path, { log_type: 'job', plane: 'primary' });
    expect(queue.body.item.resolved).toBe(true);
    expect(queue.body.item.target_status).toEqual({
      target_type: 'queue',
      binding_ref: null,
      binding_configured: true,
    });

    coreFakes.resolveRuntimeTarget.mockResolvedValue(null);
    const none = await call(createApp(READ), 'POST', path, { log_type: 'job', plane: 'primary' });
    expect(none.body.item).toMatchObject({
      resolved: false,
      resolution: null,
      target_status: { target_type: null, binding_ref: null, binding_configured: false },
    });

    coreFakes.resolveRuntimeTarget.mockResolvedValue({ target: null });
    const emptyTarget = await call(createApp(READ), 'POST', path, {
      log_type: 'job',
      plane: 'primary',
    });
    expect(emptyTarget.body.item.resolved).toBe(true);
    expect(emptyTarget.body.item.target_status.binding_configured).toBe(false);
  });

  it('answers 500 when resolution throws', async () => {
    coreFakes.resolveRuntimeTarget.mockRejectedValue(new Error('boom'));
    const res = await call(createApp(READ), 'POST', path, { log_type: 'job', plane: 'primary' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe('runtime/topology', () => {
  beforeEach(() => resetFakes());
  const path = `${POLICIES}/runtime/topology`;

  it('requires read permission and tenant scope', async () => {
    expect((await call(createApp([]), 'GET', path)).status).toBe(403);
    const mismatch = await call(createApp(READ), 'GET', `${path}?tenant_id=tenant-b`);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.details.permission.reason).toBe('tenant_scope_mismatch');
  });

  it('reports binding presence, archive mode and resolved profiles', async () => {
    coreFakes.resolveTenantProfiles.mockResolvedValue({ residencyProfile: 'eu' });
    const archiveEnv = {
      ...envFixture,
      DB_PII: {},
      AUTHRIM_LOG_ARCHIVE_MODE: 'iceberg',
      LOGGING_DELIVERY_QUEUE: {},
    } as unknown as Env;
    const res = await call(
      createPlatformApp(READ),
      'GET',
      `${path}?filter[tenant_id]=tenant-z`,
      undefined,
      {},
      archiveEnv
    );
    expect(res.status).toBe(200);
    expect(coreFakes.resolveTenantProfiles).toHaveBeenCalledWith(archiveEnv, 'tenant-z');
    expect(res.body.item).toMatchObject({
      tenant_id: 'tenant-z',
      tenant_key: expect.any(String),
      runtime_profiles: { residencyProfile: 'eu' },
      bindings: {
        db: false,
        db_admin: true,
        db_pii: true,
        logging_index_db: false,
        authrim_config: true,
        log_archive: true,
        log_archive_mode: 'iceberg',
        sensitive_details: true,
        logging_delivery_critical_queue: false,
        logging_delivery_queue: true,
        logging_delivery_bulk_queue: false,
      },
    });
    expect(res.body.item.checked_at).toEqual(expect.any(Number));
  });

  it('reports a null archive mode and folds a profile failure into the payload', async () => {
    coreFakes.resolveTenantProfiles.mockRejectedValueOnce(new Error('profile exploded'));
    const failed = await call(createApp(READ), 'GET', path);
    expect(failed.status).toBe(200);
    expect(failed.body.item.runtime_profiles).toEqual({ error: 'profile exploded' });
    expect(failed.body.item.bindings.log_archive_mode).toBeNull();

    coreFakes.resolveTenantProfiles.mockRejectedValueOnce('not-an-error');
    const opaque = await call(createApp(READ), 'GET', path);
    expect(opaque.body.item.runtime_profiles).toEqual({ error: 'profile_resolution_failed' });
  });

  it('skips profile resolution when no tenant can be determined', async () => {
    const res = await call(createPlatformApp(READ), 'GET', path, undefined, {
      'x-test-tenant-id': '',
    });
    expect(res.status).toBe(200);
    expect(res.body.item.tenant_key).toBeNull();
    expect(res.body.item.runtime_profiles).toBeNull();
    expect(coreFakes.resolveTenantProfiles).not.toHaveBeenCalled();
  });
});
