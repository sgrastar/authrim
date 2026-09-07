import { describe, expect, it, vi } from 'vitest';
import type { ReleaseMigrationManifest } from '../core/release-migrations.js';

const runD1MigrationsMock = vi.hoisted(() => vi.fn());

vi.mock('../core/cloudflare.js', () => ({
  runD1Migrations: runD1MigrationsMock,
}));

import {
  applyReleaseSchemaUpdatePlan,
  type ReleaseSchemaUpdatePlan,
} from '../core/release-update.js';

const manifest: ReleaseMigrationManifest = {
  formatVersion: 2,
  productVersion: '1.1.0',
  streams: [
    {
      id: 'core-d1',
      schemaFamily: 'core',
      dialect: 'sqlite',
      targetKind: 'cloudflare-d1',
      logicalRoles: ['core', 'tenant_core'],
      files: [{ path: '001_core.sql', checksum: 'a'.repeat(64) }],
    },
  ],
};

function plan(databaseId?: string): ReleaseSchemaUpdatePlan {
  const target = {
    id: 'd1:locked-core-id:core-d1',
    streamId: 'core-d1',
    driver: 'd1' as const,
    scope: 'deployment' as const,
    logicalRoles: ['core'],
    binding: 'DB',
    ...(databaseId ? { databaseId } : {}),
    databaseName: 'test-authrim-core-db',
    automatic: true,
  };
  const targetPlan = {
    target,
    changedFiles: ['001_core.sql'],
    requiresAction: true,
  };
  return {
    productVersion: manifest.productVersion,
    targets: [targetPlan],
    automaticTargets: [targetPlan],
    manualTargets: [],
    blockedTargets: [],
  };
}

describe('release update exact D1 identity', () => {
  it('migrates the immutable lock UUID instead of the mutable database name', async () => {
    runD1MigrationsMock.mockReset();
    runD1MigrationsMock.mockResolvedValue({ success: true, appliedCount: 1, skippedCount: 0 });

    await expect(
      applyReleaseSchemaUpdatePlan({
        plan: plan('locked-core-id'),
        manifest,
        migrationsRoot: '/workspace/migrations',
      })
    ).resolves.toMatchObject({ success: true });

    expect(runD1MigrationsMock).toHaveBeenCalledOnce();
    expect(runD1MigrationsMock).toHaveBeenCalledWith(
      'locked-core-id',
      '/workspace/migrations/core/d1',
      undefined,
      expect.objectContaining({ releaseVersion: '1.1.0' })
    );
  });

  it('fails closed without an immutable UUID and never migrates a same-name database', async () => {
    runD1MigrationsMock.mockReset();

    await expect(
      applyReleaseSchemaUpdatePlan({
        plan: plan(),
        manifest,
        migrationsRoot: '/workspace/migrations',
      })
    ).resolves.toEqual({
      success: false,
      results: [
        {
          targetId: 'd1:locked-core-id:core-d1',
          success: false,
          appliedCount: 0,
          skippedCount: 0,
          error: 'release_migration_target_database_id_required:d1:locked-core-id:core-d1',
        },
      ],
    });
    expect(runD1MigrationsMock).not.toHaveBeenCalled();
  });
});
