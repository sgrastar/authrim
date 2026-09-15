import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  database: {},
  exportStep: vi.fn(),
  importStep: vi.fn(),
  cleanupStep: vi.fn(),
  scheduler: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (load) => ({
  ...(await load()),
  requireDedicatedAdminDatabaseAdapter: () => mocks.database,
}));
vi.mock('../tenant-backup-export-dispatcher', () => ({
  runTenantBackupExportOperationStep: mocks.exportStep,
}));
vi.mock('../tenant-backup-import-dispatcher', () => ({
  runTenantBackupImportOperationStep: mocks.importStep,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-cleanup', () => ({
  runTenantBackupOperationCleanupStep: mocks.cleanupStep,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-scheduler', () => ({
  runTenantBackupScheduler: mocks.scheduler,
}));

import {
  createTenantBackupOperationHandlers,
  processTenantBackupOperations,
  type TenantBackupInstalledOperationAdapter,
} from '../tenant-backup-operation-dispatcher';

describe('tenant backup operation dispatcher', () => {
  it('routes export, import and cancellation through one installed handler set', async () => {
    const now = () => 123;
    const adapter = {
      export: {},
      import: {},
      cleanup: {},
    } as unknown as TenantBackupInstalledOperationAdapter;
    const bucket = {};
    const env = { EXPORT_ARTIFACTS: bucket } as unknown as Env;
    const handlers = createTenantBackupOperationHandlers(env, adapter, now);
    const exportContext = { operation: { kind: 'export' } } as never;
    const importContext = { operation: { kind: 'import' } } as never;
    const result = { phase: 'next', cursor: null, disposition: 'continue' };
    mocks.exportStep.mockResolvedValueOnce(result);
    mocks.importStep.mockResolvedValueOnce(result);
    mocks.cleanupStep.mockResolvedValueOnce({ cursor: null, done: true });

    await expect(handlers.run(exportContext)).resolves.toBe(result);
    await expect(handlers.run(importContext)).resolves.toBe(result);
    await expect(handlers.cleanup(importContext)).resolves.toEqual({ cursor: null, done: true });
    expect(mocks.exportStep).toHaveBeenCalledWith(env, exportContext, adapter.export, now);
    expect(mocks.importStep).toHaveBeenCalledWith(env, importContext, adapter.import, now);
    expect(mocks.cleanupStep).toHaveBeenCalledWith({
      database: mocks.database,
      context: importContext,
      adapter: adapter.cleanup,
      artifactBucket: bucket,
      now,
    });
  });

  it('runs the bounded scheduler with the same installed handlers', async () => {
    const controller = new AbortController();
    const now = () => 456;
    const adapter = {
      export: {},
      import: {},
      cleanup: {},
    } as unknown as TenantBackupInstalledOperationAdapter;
    const expected = { inspected: 1, advanced: 1, failures: 0 };
    mocks.scheduler.mockResolvedValueOnce(expected);
    const env = {} as Env;
    await expect(processTenantBackupOperations(env, adapter, controller.signal, now)).resolves.toBe(
      expected
    );
    expect(mocks.scheduler).toHaveBeenCalledOnce();
    expect(mocks.scheduler.mock.calls[0]?.[0]).toBe(mocks.database);
    expect(mocks.scheduler.mock.calls[0]?.[2]).toBe(controller.signal);
    expect(mocks.scheduler.mock.calls[0]?.[3]).toBe(now);
    expect(mocks.scheduler.mock.calls[0]?.[4]).toEqual(['export', 'import']);
  });

  it('passes an export-only claim filter to the scheduler', async () => {
    const adapter = {
      export: {},
      import: {},
      cleanup: {},
    } as unknown as TenantBackupInstalledOperationAdapter;
    mocks.scheduler.mockResolvedValueOnce({ inspected: 0, advanced: 0, failures: 0 });

    await processTenantBackupOperations({} as Env, adapter, new AbortController().signal, () => 1, [
      'export',
    ]);

    expect(mocks.scheduler.mock.lastCall?.[4]).toEqual(['export']);
  });

  it('resolves the installed adapter after the scheduler claims an operation context', async () => {
    const now = () => 789;
    const adapter = {
      export: {},
      import: {},
      cleanup: {},
    } as unknown as TenantBackupInstalledOperationAdapter;
    const resolver = vi.fn(async () => adapter);
    const env = {} as Env;
    const context = { operation: { kind: 'export' } } as never;
    const result = { phase: 'next', cursor: null, disposition: 'continue' };
    mocks.exportStep.mockResolvedValueOnce(result);

    await expect(
      createTenantBackupOperationHandlers(env, resolver, now).run(context)
    ).resolves.toBe(result);

    expect(resolver).toHaveBeenCalledWith(context);
    expect(mocks.exportStep).toHaveBeenCalledWith(env, context, adapter.export, now);
  });
});
