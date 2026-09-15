import { describe, expect, it, vi } from 'vitest';
import {
  hasTenantBackupMutationCoverage,
  runTenantBackupCoveredEffect,
  TenantBackupMutationUnavailableError,
  withTenantBackupMutationCoverage,
} from '../covered-mutation';

describe('tenant backup covered effect', () => {
  it('runs without Control only when backup support is disabled', async () => {
    const run = vi.fn(async () => 'ok');
    await expect(runTenantBackupCoveredEffect({}, { tenantId: 'tenant-a' }, run)).resolves.toBe(
      'ok'
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('holds one tenant permit around an awaited effect', async () => {
    const order: string[] = [];
    const acquire = vi.fn(async () => {
      order.push('acquire');
      return { admitted: true };
    });
    const complete = vi.fn(async () => {
      order.push('complete');
    });
    await expect(
      runTenantBackupCoveredEffect(
        {
          TENANT_BACKUP_WRAPPING_KEY: 'enabled',
          CONTROL: {
            acquireTenantBackupMutationPermit: acquire,
            completeTenantBackupMutationPermit: complete,
          },
        },
        { tenantId: 'tenant-a' },
        async () => {
          order.push('run');
          return 7;
        }
      )
    ).resolves.toBe(7);
    expect(order).toEqual(['acquire', 'run', 'complete']);
    expect(acquire.mock.calls[0]?.[0].permitId).toBe(complete.mock.calls[0]?.[0].permitId);
  });

  it('uses the environment permit for effects without a tenant ID', async () => {
    const acquire = vi.fn(async () => ({ admitted: true }));
    const complete = vi.fn(async () => {});
    await runTenantBackupCoveredEffect(
      {
        TENANT_BACKUP_WRAPPING_KEY: 'enabled',
        CONTROL: {
          acquireEnvironmentBackupMutationPermit: acquire,
          completeEnvironmentBackupMutationPermit: complete,
        },
      },
      { environment: true },
      async () => undefined
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('reuses inherited coverage without acquiring a nested permit', async () => {
    const acquire = vi.fn(async () => ({ admitted: true }));
    const environment = withTenantBackupMutationCoverage(
      {
        TENANT_BACKUP_WRAPPING_KEY: 'enabled',
        CONTROL: { acquireTenantBackupMutationPermit: acquire },
      },
      { environment: true }
    );
    expect(hasTenantBackupMutationCoverage(environment, { tenantId: 'tenant-a' })).toBe(true);
    await expect(
      runTenantBackupCoveredEffect(environment, { tenantId: 'tenant-a' }, async () => 'saved')
    ).resolves.toBe('saved');
    expect(acquire).not.toHaveBeenCalled();

    const tenant = withTenantBackupMutationCoverage({}, { tenantId: 'tenant-a' });
    expect(hasTenantBackupMutationCoverage(tenant, { tenantId: 'tenant-a' })).toBe(true);
    expect(hasTenantBackupMutationCoverage(tenant, { tenantId: 'tenant-b' })).toBe(false);
    expect(hasTenantBackupMutationCoverage(tenant, { environment: true })).toBe(false);
  });

  it('does not run or complete when admission is denied', async () => {
    const run = vi.fn(async () => undefined);
    const complete = vi.fn(async () => {});
    await expect(
      runTenantBackupCoveredEffect(
        {
          TENANT_BACKUP_WRAPPING_KEY: 'enabled',
          CONTROL: {
            acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: false })),
            completeEnvironmentBackupMutationPermit: complete,
          },
        },
        { environment: true },
        run
      )
    ).rejects.toBeInstanceOf(TenantBackupMutationUnavailableError);
    expect(run).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('completes the permit after a failed effect and preserves the effect error', async () => {
    const complete = vi.fn(async () => {});
    const input = {
      TENANT_BACKUP_WRAPPING_KEY: 'enabled',
      CONTROL: {
        acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: true })),
        completeEnvironmentBackupMutationPermit: complete,
      },
    };
    await expect(
      runTenantBackupCoveredEffect(input, { environment: true }, async () => {
        throw new Error('storage failed');
      })
    ).rejects.toThrow('storage failed');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable completion acknowledgement without rerunning the effect', async () => {
    const complete = vi.fn(async () => {
      throw new Error('lost');
    });
    const run = vi.fn(async () => 'written');
    const input = {
      TENANT_BACKUP_WRAPPING_KEY: 'enabled',
      CONTROL: {
        acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: true })),
        completeEnvironmentBackupMutationPermit: complete,
      },
    };
    await expect(
      runTenantBackupCoveredEffect(input, { environment: true }, run)
    ).rejects.toBeInstanceOf(TenantBackupMutationUnavailableError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
