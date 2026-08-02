import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensure = vi.hoisted(() => vi.fn());
const cleanup = vi.hoisted(() => vi.fn());
const withEnvironmentOperation = vi.hoisted(() => vi.fn());
vi.mock('../core/cloudflare.js', () => ({
  ensureSetupMachineAccessInD1: ensure,
  cleanupSetupMachineAccessInD1: cleanup,
}));
vi.mock('../core/lock.js', () => ({
  withEnvironmentOperationForEnvironment: withEnvironmentOperation,
}));

import { withEphemeralSetupMachineAccess } from '../core/setup-machine-access-lifecycle.js';

const config = { env: 'test' } as never;

describe('ephemeral setup machine access lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensure.mockResolvedValue({ success: true });
    cleanup.mockResolvedValue({ success: true });
    withEnvironmentOperation.mockImplementation(
      async (_input: unknown, callback: () => Promise<unknown>) => callback()
    );
  });

  it('removes machine access after a successful action', async () => {
    await expect(
      withEphemeralSetupMachineAccess({
        baseDir: '/repo',
        env: 'test',
        config,
        keysDir: '/keys',
        action: async () => 'result',
      })
    ).resolves.toBe('result');
    expect(ensure).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith('test', '/keys');
  });

  it('removes machine access after an action failure', async () => {
    await expect(
      withEphemeralSetupMachineAccess({
        baseDir: '/repo',
        env: 'test',
        config,
        keysDir: '/keys',
        action: async () => {
          throw new Error('action_failed');
        },
      })
    ).rejects.toThrow('action_failed');
    expect(cleanup).toHaveBeenCalledWith('test', '/keys');
  });

  it('cleans up a potentially partial bootstrap before reporting failure', async () => {
    ensure.mockResolvedValue({ success: false, error: 'response_lost' });
    const action = vi.fn();
    await expect(
      withEphemeralSetupMachineAccess({
        baseDir: '/repo',
        env: 'test',
        config,
        keysDir: '/keys',
        action,
      })
    ).rejects.toThrow('control_setup_machine_bootstrap_failed:response_lost');
    expect(action).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith('test', '/keys');
  });

  it('reports both bootstrap and cleanup failures', async () => {
    ensure.mockResolvedValue({ success: false, error: 'response_lost' });
    cleanup.mockResolvedValue({ success: false, error: 'cleanup_failed' });
    await expect(
      withEphemeralSetupMachineAccess({
        baseDir: '/repo',
        env: 'test',
        config,
        keysDir: '/keys',
        action: async () => 'unused',
      })
    ).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'control_setup_machine_bootstrap_cleanup_failed',
    });
  });

  it('does not report success when cleanup fails', async () => {
    cleanup.mockResolvedValue({ success: false, error: 'cleanup_failed' });
    await expect(
      withEphemeralSetupMachineAccess({
        baseDir: '/repo',
        env: 'test',
        config,
        keysDir: '/keys',
        action: async () => 'result',
      })
    ).rejects.toThrow('control_setup_machine_cleanup_failed:cleanup_failed');
  });

  it('holds the environment operation lock for bootstrap, action, and cleanup', async () => {
    await withEphemeralSetupMachineAccess({
      baseDir: '/repo',
      env: 'test',
      config,
      keysDir: '/keys',
      action: async () => 'result',
    });

    expect(withEnvironmentOperation).toHaveBeenCalledWith(
      {
        baseDir: '/repo',
        env: 'test',
        operation: 'control-capacity-machine-access',
        requireExisting: true,
      },
      expect.any(Function)
    );
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0]);
  });

  it('does not create machine access when the environment operation lock is unavailable', async () => {
    withEnvironmentOperation.mockRejectedValue(
      new Error('environment_operation_in_progress:update:123')
    );

    await expect(
      withEphemeralSetupMachineAccess({
        baseDir: '/repo',
        env: 'test',
        config,
        keysDir: '/keys',
        action: async () => 'unused',
      })
    ).rejects.toThrow('environment_operation_in_progress:update:123');
    expect(ensure).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
