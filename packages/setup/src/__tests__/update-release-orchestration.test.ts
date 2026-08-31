import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assertProductUpgradeAllowed,
  assertUpdateCloudflareResourceIdentity,
  getWorkspaceVersionMismatches,
  includeWorkersMissingExactVersionEvidence,
  includeRequiredReleaseControlCoordinator,
  includeRequiredReleaseManagement,
  resolveLegacyDeploymentVersion,
  resolveSchemaExecutionState,
  splitReleaseDeploymentForControlCoordinator,
  splitReleaseSchemaTargetsForControlHandoff,
  getUiComponentsToUpdate,
  isUpdateSourceLockUnchanged,
  updateLockWithDeploymentsAndVersions,
  recoverActiveControlReleaseRollout,
  withRecoveredReleaseUpdateState,
  withReleaseUpdateState,
  withSchemaTargetStates,
} from '../cli/commands/update.js';
import { AuthrimLockSchema } from '../core/lock.js';
import type { ReleaseSchemaUpdatePlan } from '../core/release-update.js';
import { createDefaultConfig } from '../core/config.js';
import {
  D1_DATABASES,
  KV_NAMESPACES,
  getD1DatabaseName,
  getKVNamespaceName,
} from '../core/naming.js';

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

function lockedCloudflareResources() {
  const base = lock();
  const d1 = Object.fromEntries(
    D1_DATABASES.map((database) => {
      const name = getD1DatabaseName('prod', database.dbType);
      return [database.binding, { id: `id-${database.binding}`, name }];
    })
  );
  const kv = Object.fromEntries(
    KV_NAMESPACES.map((binding) => {
      const name = getKVNamespaceName('prod', binding);
      return [binding, { id: `id-${binding}`, name }];
    })
  );
  return AuthrimLockSchema.parse({
    ...base,
    d1,
    kv,
    r2: {
      MIGRATION_RELEASES: { name: 'prod-migration-releases' },
    },
  });
}

describe('release update orchestration', () => {
  it('never exits the process while update operation locks are held', async () => {
    const source = await readFile(new URL('../cli/commands/update.ts', import.meta.url), 'utf-8');
    const lockedUpdate = source.slice(
      source.indexOf(
        "const operationLock = await acquireEnvironmentOperationLock(lockPath, 'update')"
      )
    );

    expect(lockedUpdate).not.toContain('process.exit(');
    expect(lockedUpdate).toContain('await deployConfigLock?.release()');
    expect(lockedUpdate).toContain('await operationLock.release()');
  });

  it('pins update config and lock environment identity before planning and reuses the locked config', async () => {
    const source = await readFile(new URL('../cli/commands/update.ts', import.meta.url), 'utf-8');
    const initialLockLoad = source.indexOf('await loadLockFileAuto(baseDir, env)');
    const initialLockIdentity = source.indexOf('if (lock.env !== env)', initialLockLoad);
    const initialConfigRead = source.indexOf(
      "await readFile(envPaths.config, 'utf-8')",
      initialLockIdentity
    );
    const initialConfigIdentity = source.indexOf(
      'if (config.environment.prefix !== env)',
      initialConfigRead
    );
    const versionPlanning = source.indexOf('const localVersions = await getLocalPackageVersions');
    const operationLock = source.indexOf(
      "const operationLock = await acquireEnvironmentOperationLock(lockPath, 'update')"
    );
    const lockedConfigIdentity = source.indexOf(
      'if (lockedConfig.environment.prefix !== env)',
      operationLock
    );

    expect(initialLockIdentity).toBeGreaterThan(initialLockLoad);
    expect(initialConfigIdentity).toBeGreaterThan(initialConfigRead);
    expect(versionPlanning).toBeGreaterThan(initialConfigIdentity);
    expect(lockedConfigIdentity).toBeGreaterThan(operationLock);
    expect(source).toContain('loginUi: lockedConfig.components.loginUi ?? true');
    expect(source).toContain('const workersDevEnabled = !lockedConfig.urls?.api?.custom;');
  });

  it('requires exact immutable Cloudflare identities before a release mutation', () => {
    const resourceLock = lockedCloudflareResources();
    const databases = D1_DATABASES.map((database) => ({
      name: getD1DatabaseName('prod', database.dbType),
      uuid: `id-${database.binding}`,
    }));
    const namespaces = KV_NAMESPACES.map((binding) => ({
      title: getKVNamespaceName('prod', binding),
      id: `id-${binding}`,
    }));
    const exactInput = {
      lock: resourceLock,
      env: 'prod',
      databases,
      namespaces,
      queues: [],
      requiredQueues: [],
      r2Buckets: [{ name: 'prod-migration-releases' }],
      requiredR2BucketNames: ['prod-migration-releases'],
    };

    expect(() => assertUpdateCloudflareResourceIdentity(exactInput)).not.toThrow();
    expect(() =>
      assertUpdateCloudflareResourceIdentity({
        ...exactInput,
        databases: databases.map((database, index) =>
          index === 0 ? { ...database, uuid: 'replacement-database-id' } : database
        ),
      })
    ).toThrow('cloudflare_resource_identity_mismatch');
    expect(() => assertUpdateCloudflareResourceIdentity({ ...exactInput, r2Buckets: [] })).toThrow(
      'required_cloudflare_resources_missing:R2:prod-migration-releases'
    );
  });

  it('records only fully successful exact Worker versions and retries post-traffic failures', () => {
    const source = AuthrimLockSchema.parse({
      ...lock(),
      workers: {
        'ar-control': {
          name: 'prod-ar-control',
          version: '1.0.0',
          deployedAt: '2026-07-21T00:00:00.000Z',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
        },
      },
    });
    const failedAfterTraffic = updateLockWithDeploymentsAndVersions(
      source,
      [
        {
          component: 'ar-control',
          workerName: 'prod-ar-control',
          success: false,
          trafficCommitted: true,
          error: 'trigger synchronization failed',
          deployedAt: '2026-07-21T00:01:00.000Z',
          version: '1.1.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000002',
        },
      ],
      { 'ar-control': '1.1.0' }
    );
    expect(failedAfterTraffic.workers?.['ar-control']).toEqual(source.workers?.['ar-control']);

    const completed = updateLockWithDeploymentsAndVersions(
      source,
      [
        {
          component: 'ar-control',
          workerName: 'prod-ar-control',
          success: true,
          deployedAt: '2026-07-21T00:02:00.000Z',
          version: '1.1.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000003',
          cloudflareScriptTag: 'immutable-control-script-tag',
        },
      ],
      { 'ar-control': '1.1.0' }
    );
    expect(completed.workers?.['ar-control']).toMatchObject({
      version: '1.1.0',
      cloudflareVersionId: '00000000-0000-4000-8000-000000000003',
      cloudflareScriptTag: 'immutable-control-script-tag',
    });
    expect(() =>
      updateLockWithDeploymentsAndVersions(
        source,
        [
          {
            component: 'ar-control',
            workerName: 'prod-ar-control',
            success: true,
            deployedAt: '2026-07-21T00:02:00.000Z',
            version: '1.1.0',
          },
        ],
        { 'ar-control': '1.1.0' }
      )
    ).toThrow('worker_deployment_exact_version_unavailable:ar-control');
  });

  it('deploys the Control coordinator first when a release updates multiple API Workers', () => {
    expect(
      splitReleaseDeploymentForControlCoordinator(['ar-auth', 'ar-control', 'ar-userinfo'])
    ).toEqual({
      coordinator: ['ar-control'],
      remaining: ['ar-auth', 'ar-userinfo'],
    });
    expect(splitReleaseDeploymentForControlCoordinator(['ar-control'])).toEqual({
      coordinator: ['ar-control'],
      remaining: [],
    });
    expect(splitReleaseDeploymentForControlCoordinator(['ar-auth', 'ar-userinfo'])).toEqual({
      coordinator: [],
      remaining: ['ar-auth', 'ar-userinfo'],
    });
  });

  it('redeploys Control when managed schema work exists even at the same product version', () => {
    expect(
      includeRequiredReleaseControlCoordinator(['ar-management'], ['d1-core', 'd1-pii'], false)
    ).toEqual(['ar-management', 'ar-control']);
    expect(
      includeRequiredReleaseControlCoordinator(['ar-control', 'ar-management'], ['d1-core'], false)
    ).toEqual(['ar-control', 'ar-management']);
    expect(includeRequiredReleaseControlCoordinator(['ar-management'], [], false)).toEqual([
      'ar-management',
    ]);
    expect(includeRequiredReleaseControlCoordinator(['ar-management'], ['d1-core'], true)).toEqual([
      'ar-management',
    ]);
  });

  it('redeploys Management while resuming a release with schema changes', () => {
    expect(includeRequiredReleaseManagement(['ar-control'], true, false)).toEqual([
      'ar-control',
      'ar-management',
    ]);
    expect(includeRequiredReleaseManagement(['ar-management'], true, false)).toEqual([
      'ar-management',
    ]);
    expect(includeRequiredReleaseManagement(['ar-control'], false, false)).toEqual(['ar-control']);
    expect(includeRequiredReleaseManagement(['ar-control'], true, true)).toEqual(['ar-control']);
  });

  it('applies the Control schema before other setup-owned schemas and excludes tenant targets', () => {
    const control = {
      target: {
        id: 'd1:control:d1-control',
        streamId: 'd1-control',
        driver: 'd1' as const,
        scope: 'deployment' as const,
        logicalRoles: ['control'],
        databaseName: 'control',
        automatic: true,
      },
      changedFiles: ['024_release_migration_rollout.sql'],
      requiresAction: true,
    };
    const admin = {
      ...control,
      target: {
        ...control.target,
        id: 'd1:admin:d1-admin',
        streamId: 'd1-admin',
        logicalRoles: ['admin'],
        databaseName: 'admin',
      },
    };
    const tenant = {
      ...control,
      target: {
        ...control.target,
        id: 'tenant:core:d1-core',
        streamId: 'd1-core',
        scope: 'tenant' as const,
        logicalRoles: ['core'],
        databaseName: 'tenant-core',
      },
    };

    expect(splitReleaseSchemaTargetsForControlHandoff([admin, tenant, control])).toEqual({
      controlSchemaTargets: [control],
      remainingSetupTargets: [admin],
    });
  });

  it('includes enabled UI Workers in release completion and skips disabled UI Workers', () => {
    const config = createDefaultConfig('prod');
    const currentLock = AuthrimLockSchema.parse({
      ...lock(),
      workers: {
        'ar-login-ui': {
          name: 'prod-ar-login-ui',
          version: '1.0.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000011',
        },
        'ar-admin-ui': {
          name: 'prod-ar-admin-ui',
          version: '1.1.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000012',
        },
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

  it('forces a Worker redeploy when immutable Cloudflare version evidence is missing', () => {
    const currentLock = AuthrimLockSchema.parse({
      ...lock(),
      workers: {
        'ar-control': { name: 'prod-ar-control', version: '1.0.0' },
        'ar-auth': {
          name: 'prod-ar-auth',
          version: '1.0.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000013',
        },
      },
    });
    expect(includeWorkersMissingExactVersionEvidence([], currentLock)).toEqual(['ar-control']);

    const config = createDefaultConfig('prod');
    currentLock.workers = {
      'ar-admin-ui': { name: 'prod-ar-admin-ui', version: '1.1.0' },
    };
    expect(
      getUiComponentsToUpdate({
        config,
        lock: currentLock,
        localVersions: new Map([
          ['ar-admin-ui', '1.1.0'],
          ['ar-login-ui', '1.1.0'],
        ]),
        all: false,
      })
    ).toContain('ar-admin-ui');
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

  it('recovers a matching durable awaiting_setup rollout when the local lock is stale', () => {
    const staleLock = AuthrimLockSchema.parse({
      ...lock(),
      releaseUpdate: {
        targetVersion: '1.0.0',
        previousProductVersion: '1.0.0',
        phase: 'verified',
        manifestChecksum: 'a'.repeat(64),
        startedAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:01:00.000Z',
        appliedTargets: ['old-target'],
        manualTargets: ['old-manual-target'],
        controlOperationId: `op_release_rollout_${'1'.repeat(32)}`,
      },
    });
    const recovered = withRecoveredReleaseUpdateState(staleLock, {
      targetVersion: '1.1.0',
      manifestChecksum: 'b'.repeat(64),
      activeRollout: {
        operationId: `op_release_rollout_${'2'.repeat(32)}`,
        sourceVersion: '1.0.0',
        targetVersion: '1.1.0',
        releaseId: '1.1.0',
        manifestDigest: 'b'.repeat(64),
        phase: 'awaiting_setup',
        completedTargets: 10,
        totalTargets: 10,
        lastErrorCode: null,
        updatedAt: 100,
      },
    });

    expect(recovered.releaseUpdate).toMatchObject({
      targetVersion: '1.1.0',
      previousProductVersion: '1.0.0',
      phase: 'awaiting_setup',
      manifestChecksum: 'b'.repeat(64),
      appliedTargets: [],
      manualTargets: [],
      controlOperationId: `op_release_rollout_${'2'.repeat(32)}`,
      controlCompletedTargets: 10,
      controlTotalTargets: 10,
    });
  });

  it('loads the active Control rollout and wires the recovered state into update orchestration', async () => {
    const sourceLock = AuthrimLockSchema.parse({
      ...lock(),
      d1: {
        CONTROL_DB: { id: 'control-database-id', name: 'prod-authrim-control-db' },
      },
    });
    const activeRollout = {
      operationId: `op_release_rollout_${'4'.repeat(32)}`,
      sourceVersion: '1.0.0',
      targetVersion: '1.1.0',
      releaseId: '1.1.0',
      manifestDigest: 'd'.repeat(64),
      phase: 'awaiting_setup' as const,
      completedTargets: 3,
      totalTargets: 3,
      lastErrorCode: null,
      updatedAt: 100,
    };
    const calls: Array<{ controlDatabaseId: string; environmentId: string }> = [];
    const recovered = await recoverActiveControlReleaseRollout({
      lock: sourceLock,
      environmentId: 'prod',
      targetVersion: '1.1.0',
      manifestChecksum: 'd'.repeat(64),
      loadActiveRollout: async (input) => {
        calls.push(input);
        return activeRollout;
      },
    });

    expect(calls).toEqual([{ controlDatabaseId: 'control-database-id', environmentId: 'prod' }]);
    expect(recovered.activeRollout).toEqual(activeRollout);
    expect(recovered.lock.releaseUpdate).toMatchObject({
      phase: 'awaiting_setup',
      controlOperationId: activeRollout.operationId,
      controlCompletedTargets: 3,
      controlTotalTargets: 3,
    });
  });

  it('fails closed instead of adopting an unrelated active rollout', () => {
    const activeRollout = {
      operationId: `op_release_rollout_${'3'.repeat(32)}`,
      sourceVersion: '1.0.0',
      targetVersion: '1.1.0',
      releaseId: '1.1.0',
      manifestDigest: 'c'.repeat(64),
      phase: 'awaiting_setup' as const,
      completedTargets: 10,
      totalTargets: 10,
      lastErrorCode: null,
      updatedAt: 100,
    };
    expect(() =>
      withRecoveredReleaseUpdateState(lock(), {
        targetVersion: '1.1.0',
        manifestChecksum: 'b'.repeat(64),
        activeRollout,
      })
    ).toThrow('release_rollout_active_manifest_mismatch');
    expect(() =>
      withRecoveredReleaseUpdateState(lock(), {
        targetVersion: '1.2.0',
        manifestChecksum: 'c'.repeat(64),
        activeRollout,
      })
    ).toThrow('release_rollout_active_target_mismatch');
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

    const databaseOnlyVerified = withReleaseUpdateState(schemaApplied, {
      targetVersion: '1.1.0',
      phase: 'database_only_verified',
      manifestChecksum: checksum,
    });
    expect(databaseOnlyVerified.productVersion).toBe('1.0.0');
    expect(databaseOnlyVerified.releaseUpdate?.phase).toBe('database_only_verified');
  });
});
