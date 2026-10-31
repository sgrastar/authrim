import { describe, expect, it } from 'vitest';
import { tenantBackupInputDatasetOwners, type TenantBackupPlannedInput } from '../input-plan';

function input(
  bundleId: string,
  boundaryUnixMs: number,
  datasets: string[]
): TenantBackupPlannedInput {
  return {
    version: 1,
    kind: 'backup-input',
    identity: { key: bundleId, version: 'v1', etag: bundleId, size: 1024 },
    limits: { maxFrames: 100, maxTotalBytes: 1024 },
    manifest: {
      formatVersion: 1,
      bundleId,
      source: { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
      snapshotId: `snapshot-${bundleId}`,
      boundaryUnixMs,
      inventoryDigestSha256: 'ab'.repeat(32),
      selection: {
        settings: true,
        users: true,
        admin: false,
        artifacts: false,
        logs: { audit: false, other: false, sensitive: false, period: 'all' },
      },
      datasets: datasets.map((id) => ({
        id,
        module: id.startsWith('users.') ? 'users' : 'tenant',
        kind: id.startsWith('users.') ? 'users' : 'tenant_state',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      })),
    },
  };
}

describe('combined input dataset ownership', () => {
  it('uses the newest bundle for overlaps and retains disjoint category owners', () => {
    const older = input('11'.repeat(16), 100, ['core.tenants', 'core.settings']);
    const newer = input('22'.repeat(16), 200, ['core.tenants', 'users.accounts']);
    expect(Object.fromEntries(tenantBackupInputDatasetOwners([older, newer]))).toEqual({
      'core.settings': older.manifest.bundleId,
      'core.tenants': newer.manifest.bundleId,
      'users.accounts': newer.manifest.bundleId,
    });
  });

  it('breaks an equal-boundary tie by the explicit input order', () => {
    const first = input('11'.repeat(16), 100, ['core.tenants']);
    const second = input('22'.repeat(16), 100, ['core.tenants']);
    expect(tenantBackupInputDatasetOwners([first, second]).get('core.tenants')).toBe(
      second.manifest.bundleId
    );
  });
});
