import { expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  database: {},
  abort: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', () => ({
  requireDedicatedAdminDatabaseAdapter: () => mocks.database,
}));
vi.mock('../tenant-backup-services', () => ({ abortTenantBackupBoundary: mocks.abort }));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/restore-target-cleanup', () => ({
  cleanupTenantBackupRestoreTargetPage: mocks.restore,
}));

import { createTenantBackupInstalledCleanupAdapter } from '../tenant-backup-cleanup-adapter';

it('combines built-in boundary and restore receipts with installed physical cleanup ports', async () => {
  const env = {} as Env;
  const context = {} as never;
  const now = () => 100;
  const ports = {
    resolveSnapshotSource: vi.fn(),
    cleanupRestoreTarget: vi.fn(),
    cleanupAdditionalPage: vi.fn(async () => ({ done: true })),
    assertClean: vi.fn(),
  };
  const adapter = createTenantBackupInstalledCleanupAdapter(env, ports, now);
  mocks.restore.mockImplementationOnce(
    async (input: { cleanup(target: unknown): Promise<void> }) => {
      await input.cleanup({ targetId: 'target' });
      return { done: false };
    }
  );
  await adapter.abortBoundary(context);
  await expect(adapter.cleanupStagingPage(context)).resolves.toEqual({ done: false });
  await expect(adapter.cleanupAdditionalPage(context)).resolves.toEqual({ done: true });
  await adapter.assertClean(context);
  expect(mocks.abort).toHaveBeenCalledWith(env, context, now);
  expect(mocks.restore).toHaveBeenCalledWith(
    expect.objectContaining({ database: mocks.database, context, now })
  );
  expect(ports.cleanupRestoreTarget).toHaveBeenCalledWith(context, { targetId: 'target' });
  expect(ports.cleanupAdditionalPage).toHaveBeenCalledWith(context);
  expect(ports.assertClean).toHaveBeenCalledWith(context);
});
