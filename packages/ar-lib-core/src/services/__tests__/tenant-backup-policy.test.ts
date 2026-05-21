import { describe, expect, it } from 'vitest';
import { resolveTenantBackupPolicy } from '../tenant-backup-policy';

describe('resolveTenantBackupPolicy', () => {
  it('defaults to deletion-before-purge and manual backup without scheduled periodic backup', () => {
    expect(resolveTenantBackupPolicy()).toEqual({
      profile: 'standard',
      deletionBeforePurge: true,
      manualBackup: true,
      scheduledPeriodic: false,
      scheduledPeriodicAllowed: false,
    });
  });

  it('allows enterprise and regulated profiles to opt into scheduled periodic backup', () => {
    expect(
      resolveTenantBackupPolicy({
        profile: 'enterprise',
        scheduledPeriodicRequested: true,
      }).scheduledPeriodic
    ).toBe(true);
    expect(
      resolveTenantBackupPolicy({
        profile: 'regulated',
        scheduledPeriodicRequested: true,
      }).scheduledPeriodic
    ).toBe(true);
  });

  it('does not enable scheduled periodic backup for standard tenants', () => {
    const policy = resolveTenantBackupPolicy({
      profile: 'standard',
      scheduledPeriodicRequested: true,
    });

    expect(policy.scheduledPeriodicAllowed).toBe(false);
    expect(policy.scheduledPeriodic).toBe(false);
  });
});
