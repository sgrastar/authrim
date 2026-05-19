export type TenantBackupPolicyProfile = 'standard' | 'enterprise' | 'regulated';

export interface TenantBackupPolicyInput {
  profile?: TenantBackupPolicyProfile;
  scheduledPeriodicRequested?: boolean;
  deletionBeforePurge?: boolean;
  manualBackup?: boolean;
}

export interface TenantBackupPolicy {
  profile: TenantBackupPolicyProfile;
  deletionBeforePurge: boolean;
  manualBackup: boolean;
  scheduledPeriodic: boolean;
  scheduledPeriodicAllowed: boolean;
}

export function resolveTenantBackupPolicy(input: TenantBackupPolicyInput = {}): TenantBackupPolicy {
  const profile = input.profile ?? 'standard';
  const scheduledPeriodicAllowed = profile === 'enterprise' || profile === 'regulated';

  return {
    profile,
    deletionBeforePurge: input.deletionBeforePurge ?? true,
    manualBackup: input.manualBackup ?? true,
    scheduledPeriodic: scheduledPeriodicAllowed && input.scheduledPeriodicRequested === true,
    scheduledPeriodicAllowed,
  };
}
