/* eslint-disable @typescript-eslint/no-unsafe-assignment -- admin API response bodies are untyped JSON in these route tests */
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
const reclaimFakes = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@authrim/ar-lib-core/services/log-iceberg-intent-reclaim', () => ({
  runLogIcebergIntentReclaim: reclaimFakes.run,
}));

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { auditWrite, resetFakes } from './logging-control-b-harness';
import { ADMIN_LOGGING, call, createApp, createPlatformApp } from './logging-control-b-app';

const PATH = `${ADMIN_LOGGING}/delivery/reclaim-intents`;
const RUN = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN];
const DONE = { leased: true, abandoned: 4, retired: 0, retained: 0, failed: 0 };

beforeEach(() => {
  resetFakes();
  reclaimFakes.run.mockReset();
  reclaimFakes.run.mockResolvedValue(DONE);
});
afterEach(() => vi.useRealTimers());

describe('POST /delivery/reclaim-intents', () => {
  it('requires the repair run permission', async () => {
    expect((await call(createApp([]), 'POST', PATH, {})).status).toBe(403);
    expect(reclaimFakes.run).not.toHaveBeenCalled();
  });

  it('reclaims the caller tenant only and answers the action envelope', async () => {
    const res = await call(createApp(RUN), 'POST', PATH, {});
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(DONE);
    expect(reclaimFakes.run).toHaveBeenCalledWith(expect.anything(), { tenantId: 'tenant-a' });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.delivery.reclaim_intents',
        resourceId: 'tenant-a',
        severity: 'warn',
        metadata: expect.objectContaining({ abandoned: 4, scope: 'tenant' }),
      })
    );
  });

  it('reclaims every tenant for a platform caller', async () => {
    reclaimFakes.run.mockResolvedValue({ ...DONE, abandoned: 0 });
    const res = await call(createPlatformApp(RUN), 'POST', PATH, {});
    expect(res.status).toBe(200);
    expect(reclaimFakes.run).toHaveBeenCalledWith(expect.anything(), {});
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceId: 'platform', severity: 'info' })
    );
  });

  it('answers 409 when the archive is not activated or not in pipeline mode', async () => {
    reclaimFakes.run.mockRejectedValue(new Error('log_iceberg_not_activated'));
    expect((await call(createApp(RUN), 'POST', PATH, {})).status).toBe(409);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('turns an unexpected failure into a 500', async () => {
    reclaimFakes.run.mockRejectedValue(new Error('boom'));
    expect((await call(createApp(RUN), 'POST', PATH, {})).status).toBe(500);
  });
});
