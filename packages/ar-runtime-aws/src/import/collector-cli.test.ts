import { describe, expect, it } from 'vitest';
import {
  resolveAwsSupplementCollectorPlan,
  type AwsSupplementCollectorPlan,
} from './collector-cli';

function plan(): AwsSupplementCollectorPlan {
  return {
    formatVersion: 1,
    backup: {
      partPaths: ['/private/tmp/source.part'],
      receipt: {
        source: {
          tenantId: 'tenant-a',
          issuer: 'https://tenant-a.example.test',
          productVersion: '0.4.2',
        },
        bundleId: 'a'.repeat(32),
        snapshotId: 'snapshot-a',
        inventoryDigestSha256: 'b'.repeat(64),
        parts: [{ size: 1, sha256: 'c'.repeat(64) }],
      },
      selection: {
        settings: true,
        users: true,
        admin: false,
        artifacts: false,
        logs: { audit: false, other: false, sensitive: false, period: 7 },
      },
      datasets: [],
      maxSnapshotAgeMs: 60_000,
      passphraseEnv: 'TEST_BACKUP_PASSPHRASE',
    },
    capture: { path: '/private/tmp/capture.json', expectedSha256: 'd'.repeat(64) },
    outputPath: '/private/tmp/supplement.json',
  };
}

describe('AWS supplement collector plan', () => {
  it('resolves the passphrase only from a named environment variable', () => {
    const resolved = resolveAwsSupplementCollectorPlan(plan(), {
      TEST_BACKUP_PASSPHRASE: 'synthetic-passphrase',
    });
    expect(resolved.backup.passphrase).toBe('synthetic-passphrase');
    expect(resolved.capture).toEqual({
      path: '/private/tmp/capture.json',
      expectedSha256: 'd'.repeat(64),
    });
  });

  it('accepts an embedded capture without any sidecar path or hash', () => {
    const input = plan();
    input.capture = { source: 'bundle' };
    expect(
      resolveAwsSupplementCollectorPlan(input, { TEST_BACKUP_PASSPHRASE: 'synthetic-passphrase' })
        .capture
    ).toEqual({ source: 'bundle' });
  });

  it('rejects missing secret and inline secret fields', () => {
    expect(() => resolveAwsSupplementCollectorPlan(plan(), {})).toThrow(
      'aws_supplement_collector_plan_invalid'
    );
    const inline = plan();
    (inline.backup as typeof inline.backup & { passphrase?: string }).passphrase = 'not-allowed';
    expect(() =>
      resolveAwsSupplementCollectorPlan(inline, {
        TEST_BACKUP_PASSPHRASE: 'synthetic-passphrase',
      })
    ).toThrow('aws_supplement_collector_plan_invalid');
  });
});
