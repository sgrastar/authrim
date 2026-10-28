import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTenantBackupMutationCoverage, type Env } from '@authrim/ar-lib-core';
const mocks = vi.hoisted(() => ({
  maintenance: vi.fn(),
  operations: vi.fn(),
  audit: vi.fn(),
  logging: vi.fn(),
  iceberg: vi.fn(),
}));
vi.mock('../tenant-backup-services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-backup-services')>()),
  processTenantBackupMaintenance: mocks.maintenance,
}));
vi.mock('../tenant-backup-operation-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-backup-operation-dispatcher')>()),
  processTenantBackupOperations: mocks.operations,
}));
vi.mock('../log-iceberg-maintenance', () => ({ runLogIcebergScheduledMaintenance: mocks.iceberg }));
vi.mock('../r2-storage-maintenance', async (original) => ({
  ...(await original<typeof import('../r2-storage-maintenance')>()),
  runTrackedMaintenanceTask: async (
    _env: unknown,
    _id: string,
    operation: () => Promise<unknown>
  ) => {
    await operation();
  },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  processAuditQueue: mocks.audit,
  processLoggingDeliveryQueue: mocks.logging,
}));
import worker from '../index';
function environment(admitted = true) {
  const control = {
    acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted })),
    completeEnvironmentBackupMutationPermit: vi.fn(async () => {}),
  };
  return {
    control,
    env: { ENABLE_SAML_DR_EXPORT: 'true', SAML_DR_MUTATION_CONTROL: control } as unknown as Env,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.maintenance.mockResolvedValue({ keysRemoved: 0 });
  mocks.operations.mockResolvedValue({ inspected: 0, advanced: 0, failures: 0, failureCodes: [] });
  mocks.audit.mockResolvedValue(undefined);
  mocks.logging.mockResolvedValue(undefined);
  mocks.iceberg.mockResolvedValue({ ran: true, mode: 'scheduled' });
});
describe('Management opt-in SAML DR admission', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'POST'])(
    'fences %s before HTTP effects even without a backup wrapping key',
    async (method) => {
      const { env, control } = environment(false);
      const response = await worker.fetch(
        new Request('https://idp.example.test/api/admin/tenant-backups/operations', { method }),
        env
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
      expect(mocks.operations).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['POST', '/api/replication-backups/grant-a/exports'],
    ['GET', '/api/replication-backups/grant-a/exports/operation-a/export-receipt'],
    ['GET', '/api/replication-backups/grant-a/exports/operation-a/download'],
  ])(
    'reaches only the separate grant authenticator for %s %s during drain',
    async (method, path) => {
      const { env, control } = environment(false);
      const response = await worker.fetch(
        new Request('https://idp.example.test' + path, { method }),
        env
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'backup_replication_grant_denied' });
      expect(control.acquireEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
      for (const effect of [mocks.maintenance, mocks.operations, mocks.audit, mocks.logging])
        expect(effect).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['POST', '/api/replication-backups/grant-a/imports'],
    ['POST', '/api/replication-backups/grant-a/exports/operation-a/approve'],
    ['DELETE', '/api/replication-backups/grant-a/exports/operation-a'],
    ['POST', '/api/admin/replication-backups/grants'],
  ])('does not exempt unrelated %s %s from business-writer admission', async (method, path) => {
    const { env, control } = environment(false);
    const response = await worker.fetch(
      new Request('https://idp.example.test' + path, { method }),
      env
    );
    expect(response.status).toBe(503);
    expect(control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
    expect(mocks.operations).not.toHaveBeenCalled();
  });
  it('requires HTTPS even for the isolated export control surface', async () => {
    const { env, control } = environment(false);
    const response = await worker.fetch(
      new Request('http://idp.example.test/api/replication-backups/grant-a/exports', {
        method: 'POST',
      }),
      env
    );
    expect(response.status).toBe(426);
    expect(control.acquireEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
  });

  it.each(['AUDIT_QUEUE', 'LOGGING_DELIVERY_CRITICAL_QUEUE'])(
    'fences queue %s before consumer side effects',
    async (queue) => {
      const { env, control } = environment(false);
      await expect(
        worker.queue({ queue, messages: [] } as unknown as MessageBatch<unknown>, env)
      ).rejects.toThrow('backup_mutation_unavailable');
      expect(control.acquireEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(mocks.logging).not.toHaveBeenCalled();
    }
  );
  it('keeps the queue permit until its consumer finishes', async () => {
    const { env, control } = environment();
    let finish!: () => void;
    mocks.audit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const running = worker.queue(
      { queue: 'AUDIT_QUEUE', messages: [] } as unknown as MessageBatch<unknown>,
      env
    );
    await vi.waitFor(() => expect(mocks.audit).toHaveBeenCalledOnce());
    expect(control.completeEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
    finish();
    await running;
    expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
  });
  it('runs export coordination outside the permit but covers maintenance and import work', async () => {
    const { env, control } = environment();
    env.TENANT_BACKUP_WRAPPING_KEY = 'a'.repeat(64);
    env.EXPORT_ARTIFACTS = {} as R2Bucket;
    control.acquireEnvironmentBackupMutationPermit
      .mockResolvedValueOnce({ admitted: true })
      .mockResolvedValueOnce({ admitted: true })
      .mockResolvedValueOnce({ admitted: true })
      .mockResolvedValue({ admitted: false });
    mocks.iceberg.mockImplementation(async (_event: ScheduledEvent, covered: Env) => {
      expect(hasTenantBackupMutationCoverage(covered, { environment: true })).toBe(true);
      return { ran: true, mode: 'scheduled' };
    });
    mocks.maintenance.mockImplementation(async (covered: Env) => {
      expect(hasTenantBackupMutationCoverage(covered, { environment: true })).toBe(true);
      return { keysRemoved: 0 };
    });
    mocks.operations.mockImplementation(
      async (
        covered: Env,
        _adapter: unknown,
        _signal: AbortSignal,
        _now: unknown,
        kinds: string[]
      ) => {
        expect(hasTenantBackupMutationCoverage(covered, { environment: true })).toBe(
          kinds[0] === 'import'
        );
        return { inspected: 0, advanced: 0, failures: 0, failureCodes: [] };
      }
    );
    await worker.scheduled({ cron: '* * * * *' } as ScheduledEvent, env);
    expect(mocks.operations.mock.calls.map((call: unknown[]) => call[4])).toEqual([
      ['export'],
      ['import'],
    ]);
    expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledTimes(3);
  });
  it.each(['scheduled', 'pipeline'] as const)(
    'fences %s log maintenance before staging, export or retention effects',
    async (mode) => {
      const { env, control } = environment(false);
      env.AUTHRIM_LOG_ARCHIVE_MODE = mode;
      await worker.scheduled({ cron: '* * * * *' } as ScheduledEvent, env);
      expect(mocks.iceberg).not.toHaveBeenCalled();
      expect(mocks.maintenance).not.toHaveBeenCalled();
      expect(control.completeEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
    }
  );

  it('keeps log maintenance inside its permit until the work completes', async () => {
    const { env, control } = environment();
    control.acquireEnvironmentBackupMutationPermit
      .mockResolvedValueOnce({ admitted: true })
      .mockResolvedValue({ admitted: false });
    let finish!: () => void;
    mocks.iceberg.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const running = worker.scheduled({ cron: '* * * * *' } as ScheduledEvent, env);
    await vi.waitFor(() => expect(mocks.iceberg).toHaveBeenCalledOnce());
    expect(control.completeEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
    finish();
    await running;
    expect(control.completeEnvironmentBackupMutationPermit).toHaveBeenCalledOnce();
  });

  it('does not exempt another path or method that resembles the test coordinator', async () => {
    for (const [method, path, enabled] of [
      ['GET', '/api/admin/test/run-scheduled', 'true'],
      ['POST', '/api/admin/test/run-scheduled/extra', 'true'],
      ['POST', '/api/admin/test/run-scheduled', 'false'],
    ]) {
      const { env } = environment(false);
      env.ENABLE_TEST_ENDPOINTS = enabled;
      const response = await worker.fetch(
        new Request(`https://idp.example.test${path}`, { method }),
        env
      );
      expect(response.status).toBe(503);
    }
    expect(mocks.operations).not.toHaveBeenCalled();
  });
  it('the exact enabled coordinator route still requires normal Admin authentication', async () => {
    const { env, control } = environment(false);
    env.ENABLE_TEST_ENDPOINTS = 'true';
    const response = await worker.fetch(
      new Request('https://idp.example.test/api/admin/test/run-scheduled', { method: 'POST' }),
      env
    );
    expect(response.status).not.toBe(200);
    expect(control.acquireEnvironmentBackupMutationPermit).not.toHaveBeenCalled();
    expect(mocks.operations).not.toHaveBeenCalled();
    expect(mocks.maintenance).not.toHaveBeenCalled();
  });
});
