import { describe, expect, it } from 'vitest';
import {
  assertProductUpgradeAllowed,
  getWorkspaceVersionMismatches,
  resolveLegacyDeploymentVersion,
  resolveSchemaExecutionState,
  splitReleaseDeploymentForControlCoordinator,
  getUiComponentsToUpdate,
  isUpdateSourceLockUnchanged,
  withReleaseUpdateState,
  withSchemaTargetStates,
} from '../cli/commands/update.js';
import { AuthrimLockSchema } from '../core/lock.js';
import type { ReleaseSchemaUpdatePlan } from '../core/release-update.js';
import { createDefaultConfig } from '../core/config.js';

function plan(): ReleaseSchemaUpdatePlan {
  const automatic = {
    target: {
      id: 'd1:core:d1-core',
      streamId: 'd1-core',
      driver: 'd1' as const,
      scope: 'deployment' as const,
      logicalRoles: ['core'],
      databaseName: 'core',
      automatic: true,
    },
    changedFiles: ['002_next.sql'],
    requiresAction: true,
  };
  const postgres = {
    target: {
      id: 'external:postgres:core-primary',
      streamId: 'external-postgres-core',
      driver: 'postgres' as const,
      scope: 'external' as const,
      logicalRoles: ['core'],
      automatic: false,
      blockedReason: 'external_database_executor_not_configured',
    },
    changedFiles: ['002_next.sql'],
    requiresAction: true,
    blockedReason: 'external_database_executor_not_configured',
  };
  const mysql = {
    target: {
      id: 'external:mysql:core-primary',
      streamId: null,
      driver: 'mysql' as const,
      scope: 'external' as const,
      logicalRoles: ['core'],
      automatic: false,
      blockedReason: 'release_migration_stream_not_available:mysql',
    },
    changedFiles: [],
    requiresAction: true,
    blockedReason: 'release_migration_stream_not_available:mysql',
  };
  return {
    productVersion: '1.1.0',
    targets: [automatic, postgres, mysql],
    automaticTargets: [automatic],
    manualTargets: [],
    blockedTargets: [postgres, mysql],
  };
}

function lock() {
  return AuthrimLockSchema.parse({
    version: '1.0.0',
    productVersion: '1.0.0',
    createdAt: '2026-07-21T00:00:00.000Z',
    env: 'prod',
    d1: {},
    kv: {},
  });
}

describe('release update orchestration', () => {
  it('deploys the Control coordinator first when a release updates multiple API Workers', () => {
    expect(
      splitReleaseDeploymentForControlCoordinator(['ar-auth', 'ar-control', 'ar-userinfo'])
    ).toEqual({
      coordinator: ['ar-control'],
      remaining: ['ar-auth', 'ar-userinfo'],
    });
    expect(splitReleaseDeploymentForControlCoordinator(['ar-control'])).toEqual({
      coordinator: [],
      remaining: ['ar-control'],
    });
    expect(splitReleaseDeploymentForControlCoordinator(['ar-auth', 'ar-userinfo'])).toEqual({
      coordinator: [],
      remaining: ['ar-auth', 'ar-userinfo'],
    });
  });

  it('includes enabled UI Workers in release completion and skips disabled UI Workers', () => {
    const config = createDefaultConfig('prod');
    const currentLock = AuthrimLockSchema.parse({
      ...lock(),
      workers: {
        'ar-login-ui': { name: 'prod-ar-login-ui', version: '1.0.0' },
        'ar-admin-ui': { name: 'prod-ar-admin-ui', version: '1.1.0' },
      },
    });
    const versions = new Map([
      ['ar-login-ui', '1.1.0'],
      ['ar-admin-ui', '1.1.0'],
    ] as const);
    expect(
      getUiComponentsToUpdate({ config, lock: currentLock, localVersions: versions, all: false })
    ).toEqual(['ar-login-ui']);

    config.components.loginUi = false;
    expect(
      getUiComponentsToUpdate({ config, lock: currentLock, localVersions: versions, all: true })
    ).toEqual(['ar-admin-ui']);
  });

  it('fails workspace release validation for missing or mismatched required packages', () => {
    const apiVersions = Object.fromEntries(
      [
        'ar-lib-core',
        'ar-discovery',
        'ar-auth',
        'ar-token',
        'ar-userinfo',
        'ar-control',
        'ar-plugin-runner',
        'ar-management',
        'ar-agent-access',
        'ar-async',
        'ar-policy',
        'ar-saml',
        'ar-bridge',
        'ar-vc',
        'ar-router',
      ].map((component) => [component, '1.1.0'])
    );
    delete apiVersions['ar-token'];
    const mismatches = getWorkspaceVersionMismatches({
      productVersion: '1.1.0',
      apiVersions,
      uiVersions: new Map([
        ['ar-admin-ui', '1.0.0'],
        ['ar-login-ui', '1.1.0'],
      ]),
    });
    expect(mismatches).toEqual(['ar-token=missing', 'ar-admin-ui=1.0.0']);
  });

  it('rejects product downgrades while allowing same-version retries and upgrades', () => {
    expect(() => assertProductUpgradeAllowed('1.1.0', '1.0.0')).toThrow(
      'product_downgrade_not_supported:1.1.0:1.0.0'
    );
    expect(() => assertProductUpgradeAllowed('1.1.0', '1.1.0')).not.toThrow();
    expect(() => assertProductUpgradeAllowed('1.1.0', '1.2.0')).not.toThrow();
  });

  it('reconciles mixed legacy Worker versions without guessing a database release', () => {
    expect(
      resolveLegacyDeploymentVersion({
        auth: { version: '1.0.0' },
        token: { version: '1.1.0' },
        legacy: {},
      })
    ).toEqual({ ambiguous: true, upgradeFloor: '1.1.0' });
    expect(
      resolveLegacyDeploymentVersion({ auth: { version: '1.0.0' }, token: { version: '1.0.0' } })
    ).toEqual({ ambiguous: false, inferredVersion: '1.0.0', upgradeFloor: '1.0.0' });
    expect(resolveLegacyDeploymentVersion({ auth: { version: 'not-semver' } })).toEqual({
      ambiguous: false,
      invalidVersions: ['not-semver'],
    });
  });

  it('compares the locked environment with the source lock before legacy inference', () => {
    const source = AuthrimLockSchema.parse({
      ...lock(),
      productVersion: undefined,
      workers: {
        'ar-login-ui': { name: 'test-ar-login-ui', version: '1.0.0' },
      },
    });
    const inferred = { ...source, productVersion: '1.0.0' };

    expect(isUpdateSourceLockUnchanged(source, source)).toBe(true);
    expect(isUpdateSourceLockUnchanged(source, inferred)).toBe(false);
  });

  it('preserves external acknowledgements and skips completed automatic targets on resume', () => {
    const state = resolveSchemaExecutionState({
      plan: plan(),
      resumableRelease: {
        targetVersion: '1.1.0',
        previousProductVersion: '1.0.0',
        phase: 'schema_applied',
        manifestChecksum: 'a'.repeat(64),
        startedAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:01:00.000Z',
        appliedTargets: ['d1:core:d1-core'],
        manualTargets: ['external:postgres:core-primary'],
      },
      acknowledgeExternal: false,
    });
    expect([...state.acknowledgedManualTargets]).toEqual(['external:postgres:core-primary']);
    expect(state.automaticTargets).toHaveLength(0);
    expect(state.remainingBlockedTargets.map((item) => item.target.id)).toEqual([
      'external:mysql:core-primary',
    ]);
  });

  it('never lets the external-ready acknowledgement bypass a missing migration stream', () => {
    const state = resolveSchemaExecutionState({
      plan: plan(),
      acknowledgeExternal: true,
    });
    expect([...state.acknowledgedManualTargets]).toEqual(['external:postgres:core-primary']);
    expect(state.remainingBlockedTargets.map((item) => item.target.id)).toEqual([
      'external:mysql:core-primary',
    ]);
  });

  it('does not acknowledge a named stream that is absent from the selected manifest', () => {
    const missingManifestStream = {
      ...plan().blockedTargets[1],
      target: {
        ...plan().blockedTargets[1].target,
        id: 'external:postgres:missing-stream',
        driver: 'postgres' as const,
        streamId: 'external-postgres-core',
      },
      blockedReason: 'release_migration_stream_not_found:external-postgres-core',
    };
    const missingStreamPlan: ReleaseSchemaUpdatePlan = {
      productVersion: '1.1.0',
      targets: [missingManifestStream],
      automaticTargets: [],
      manualTargets: [],
      blockedTargets: [missingManifestStream],
    };
    const state = resolveSchemaExecutionState({
      plan: missingStreamPlan,
      acknowledgeExternal: true,
    });
    expect([...state.acknowledgedManualTargets]).toEqual([]);
    expect(state.remainingBlockedTargets).toEqual([missingManifestStream]);
  });

  it('persists schema target versions and advances productVersion only after verification', () => {
    const checksum = 'b'.repeat(64);
    const manifest = {
      formatVersion: 1 as const,
      productVersion: '1.1.0',
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite' as const,
          logicalRoles: ['core'],
          files: [{ path: '002_next.sql', checksum: 'c'.repeat(64) }],
        },
        {
          id: 'external-postgres-core',
          dialect: 'postgres' as const,
          logicalRoles: ['core'],
          files: [{ path: '002_next.sql', checksum: 'd'.repeat(64) }],
        },
      ],
    };
    const schemaApplied = withSchemaTargetStates(lock(), {
      targetIds: ['d1:core:d1-core', 'external:postgres:core-primary'],
      manualTargetIds: new Set(['external:postgres:core-primary']),
      productVersion: '1.1.0',
      manifestChecksum: checksum,
      targetStreamIds: new Map([
        ['d1:core:d1-core', 'd1-core'],
        ['external:postgres:core-primary', 'external-postgres-core'],
      ]),
      manifest,
    });
    expect(schemaApplied.productVersion).toBe('1.0.0');
    expect(schemaApplied.schemaTargets?.['d1:core:d1-core']?.appliedBy).toBe('automatic');
    expect(schemaApplied.schemaTargets?.['external:postgres:core-primary']?.appliedBy).toBe(
      'operator'
    );
    expect(schemaApplied.schemaTargets?.['external:postgres:core-primary']?.files).toEqual([
      { path: '002_next.sql', checksum: 'd'.repeat(64) },
    ]);

    const verified = withReleaseUpdateState(schemaApplied, {
      targetVersion: '1.1.0',
      phase: 'verified',
      manifestChecksum: checksum,
    });
    expect(verified.productVersion).toBe('1.1.0');
  });
});
