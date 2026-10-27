import { expect, it } from 'vitest';
import { resolveAwsOfflineRestorePlan, type AwsOfflineRestorePlan } from './restore-cli';

function fixture(): AwsOfflineRestorePlan {
  return {
    formatVersion: 1,
    backup: {
      partPaths: ['/private/tmp/backup.bin'],
      receipt: {
        source: {
          tenantId: 'tenant-a',
          issuer: 'https://tenant-a.example.test',
          productVersion: '0.4.2',
        },
        bundleId: 'a'.repeat(32),
        snapshotId: 'snapshot-a',
        inventoryDigestSha256: 'b'.repeat(64),
        parts: [{ size: 500, sha256: 'c'.repeat(64) }],
      },
      selection: {
        settings: true,
        users: true,
        admin: false,
        artifacts: false,
        logs: { audit: false, other: false, sensitive: false, period: 7 },
      },
      datasets: [],
      maxSnapshotAgeMs: 3_600_000,
      passphraseEnv: 'DR_BACKUP_PASSPHRASE',
    },
    supplement: { path: '/private/tmp/supplement.json', expectedSha256: 'd'.repeat(64) },
    restoreId: '11111111-1111-4111-8111-111111111111',
    core: {
      connectionStringEnv: 'DR_CORE_DATABASE_URL',
      targetId: '22222222-2222-4222-8222-222222222222',
      bindingRefs: ['core-a'],
    },
    pii: {
      connectionStringEnv: 'DR_PII_DATABASE_URL',
      targetId: '33333333-3333-4333-8333-333333333333',
      bindingRefs: ['pii-a'],
    },
    state: { connectionStringEnv: 'DR_STATE_DATABASE_URL', initializeEmptySchema: true },
    environmentName: 'local-test',
    spEntityIds: ['https://sp.example.test/entity'],
    allocationScope: 'tenant_exclusive',
    awsFlowRuntimeHmacSecretEnv: 'DR_FLOW_SECRET',
    awsLookupReadKeys: [{ generation: 1, secretEnv: 'DR_LOOKUP_SECRET' }],
  };
}

const environment = {
  DR_BACKUP_PASSPHRASE: 'synthetic-passphrase-only',
  DR_CORE_DATABASE_URL: 'postgres://localhost/core',
  DR_PII_DATABASE_URL: 'postgres://localhost/pii',
  DR_STATE_DATABASE_URL: 'postgres://localhost/state',
  DR_FLOW_SECRET: 'synthetic-flow-secret-at-least-32-bytes',
  DR_LOOKUP_SECRET: 'synthetic-lookup-secret-at-least-32-bytes',
};

it('resolves secrets only from explicit environment references', () => {
  const resolved = resolveAwsOfflineRestorePlan(fixture(), environment);
  expect(resolved.backup.passphrase).toBe(environment.DR_BACKUP_PASSPHRASE);
  expect(resolved.core.connectionString).toBe(environment.DR_CORE_DATABASE_URL);
  expect(resolved.awsLookupReadKeys).toEqual([
    { generation: 1, secret: environment.DR_LOOKUP_SECRET },
  ]);
  expect(resolved.backup).not.toHaveProperty('passphraseEnv');
  expect(resolved.core).not.toHaveProperty('connectionStringEnv');
});

it('rejects missing secrets, inline credentials, and injected clock overrides without exposing values', () => {
  expect(() => resolveAwsOfflineRestorePlan(fixture(), {})).toThrow(/^aws_restore_plan_invalid$/u);
  const inline = {
    ...fixture(),
    core: { ...fixture().core, connectionString: 'sensitive-inline-value' },
  };
  expect(() => resolveAwsOfflineRestorePlan(inline, environment)).toThrow(
    /^aws_restore_plan_invalid$/u
  );
  const clock = { ...fixture(), backup: { ...fixture().backup, nowMs: 0 } };
  expect(() => resolveAwsOfflineRestorePlan(clock, environment)).toThrow(
    /^aws_restore_plan_invalid$/u
  );
});
