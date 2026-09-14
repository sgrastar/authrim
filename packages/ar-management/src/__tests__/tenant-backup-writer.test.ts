import { expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { runTenantBackupCoveredMutation } from '../tenant-backup-writer';

it('does not write without admission and retries uncertain RPCs with the same permit', async () => {
  const run = vi.fn(async () => new Response('saved'));
  const acquire = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValue({ admitted: false });
  const complete = vi.fn();
  const env = {
    TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32),
    CONTROL: {
      acquireTenantBackupMutationPermit: acquire,
      completeTenantBackupMutationPermit: complete,
    },
  } as unknown as Env;
  expect((await runTenantBackupCoveredMutation({ env, tenantId: 'a', run })).status).toBe(503);
  expect(run).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(acquire.mock.calls[0][0]).toEqual(acquire.mock.calls[1][0]);
});
it('awaits all registered work and retains uncertain failures instead of releasing the permit', async () => {
  const complete = vi.fn().mockResolvedValue(undefined);
  const env = {
    TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32),
    CONTROL: {
      acquireTenantBackupMutationPermit: vi.fn().mockResolvedValue({ admitted: true }),
      completeTenantBackupMutationPermit: complete,
    },
  } as unknown as Env;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const execution = runTenantBackupCoveredMutation({
    env,
    tenantId: 'a',
    async run() {
      await held;
      return new Response('saved');
    },
  });
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  finish();
  expect((await execution).status).toBe(200);
  expect(complete).toHaveBeenCalledTimes(1);
  complete.mockClear();
  await expect(
    runTenantBackupCoveredMutation({
      env,
      tenantId: 'a',
      async run() {
        throw new Error('uncertain storage');
      },
    })
  ).rejects.toThrow('uncertain storage');
  expect(complete).not.toHaveBeenCalled();
  expect(
    (
      await runTenantBackupCoveredMutation({
        env,
        tenantId: 'a',
        async run() {
          return new Response(null, { status: 500 });
        },
      })
    ).status
  ).toBe(500);
  expect(complete).not.toHaveBeenCalled();
});

it('retries only completion after a successful write and reports uncertain acknowledgement', async () => {
  const acquire = vi.fn().mockResolvedValue({ admitted: true });
  const complete = vi.fn().mockRejectedValue(new Error('lost completion response'));
  const run = vi.fn(async () => new Response('saved'));
  const env = {
    TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32),
    CONTROL: {
      acquireTenantBackupMutationPermit: acquire,
      completeTenantBackupMutationPermit: complete,
    },
  } as unknown as Env;
  const response = await runTenantBackupCoveredMutation({ env, tenantId: 'a', run });
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(run).toHaveBeenCalledTimes(1);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[0][0]).toEqual(acquire.mock.calls[0][0]);
  expect(complete.mock.calls[1][0]).toEqual(acquire.mock.calls[0][0]);
});
