import { describe, expect, it, vi } from 'vitest';
import {
  assertLocalDeploymentCapacity,
  InsufficientLocalDiskSpaceError,
  isInsufficientLocalDiskSpaceError,
} from '../core/local-deployment-capacity.js';

describe('local deployment capacity', () => {
  it('returns the observed capacity when the minimum is available', async () => {
    const readAvailableBytes = vi.fn(async () => 2 * 1024 * 1024 * 1024);

    await expect(
      assertLocalDeploymentCapacity({
        rootDir: '/workspace',
        phase: 'environment provisioning',
        minimumFreeBytes: 1024 * 1024 * 1024,
        readAvailableBytes,
      })
    ).resolves.toBe(2 * 1024 * 1024 * 1024);
    expect(readAvailableBytes).toHaveBeenCalledWith('/workspace');
  });

  it('fails with an actionable typed error before the next Cloudflare mutation', async () => {
    const error = await assertLocalDeploymentCapacity({
      rootDir: '/workspace',
      phase: 'package build',
      minimumFreeBytes: 1024 * 1024 * 1024,
      readAvailableBytes: async () => 144 * 1024 * 1024,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InsufficientLocalDiskSpaceError);
    expect(isInsufficientLocalDiskSpaceError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'insufficient_local_disk_space',
      phase: 'package build',
      availableBytes: 144 * 1024 * 1024,
      requiredBytes: 1024 * 1024 * 1024,
    });
    expect((error as Error).message).toContain('144 MiB available');
    expect((error as Error).message).toContain('Free local disk space and retry');
  });

  it('rejects invalid filesystem capacity observations', async () => {
    await expect(
      assertLocalDeploymentCapacity({
        rootDir: '/workspace',
        phase: 'Worker deployment',
        minimumFreeBytes: 1,
        readAvailableBytes: async () => Number.NaN,
      })
    ).rejects.toThrow('local_disk_space_check_returned_invalid_capacity');
  });
});
