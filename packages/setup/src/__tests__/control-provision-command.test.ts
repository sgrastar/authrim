import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { D1_DATABASES, getD1DatabaseName } from '../core/naming.js';
import {
  acquireDeployConfigLock,
  acquireEnvironmentOperationForEnvironment,
} from '../core/lock.js';

const mocks = vi.hoisted(() => ({
  listPending: vi.fn(),
  listPendingPlugin: vi.fn(),
  listPendingPluginCleanup: vi.fn(),
  listPendingTenantDr: vi.fn(),
  execute: vi.fn(),
  executeMigration: vi.fn(),
  executeBindings: vi.fn(),
  executePlugin: vi.fn(),
  executePluginCleanup: vi.fn(),
  previewCapacity: vi.fn(),
  requestCapacity: vi.fn(),
  retryCapacity: vi.fn(),
  listCapacityTenants: vi.fn(),
  ensureSetupMachine: vi.fn(),
  cleanupSetupMachine: vi.fn(),
  listD1: vi.fn(),
  assertR2Use: vi.fn(),
  refreshWorkerArtifacts: vi.fn(),
  spinner: { start: vi.fn(), succeed: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));

vi.mock('ora', () => ({ default: vi.fn(() => mocks.spinner) }));
vi.mock('../core/control-operator-operations.js', () => ({
  listPendingControlOperatorOperations: mocks.listPending,
  listPendingPluginControlOperatorOperations: mocks.listPendingPlugin,
  listPendingPluginControlCleanupOperations: mocks.listPendingPluginCleanup,
  listPendingTenantDisasterRecoveryOperatorOperations: mocks.listPendingTenantDr,
}));
vi.mock('../core/control-operator-executor.js', () => ({
  executeSetupControlOperatorCreate: mocks.execute,
  executeSetupControlOperatorMigration: mocks.executeMigration,
  executeSetupControlOperatorWorkerBindings: mocks.executeBindings,
}));
vi.mock('../core/plugin-control-operator-executor.js', () => ({
  executeSetupPluginControlOperator: mocks.executePlugin,
}));
vi.mock('../core/plugin-control-cleanup-operator-executor.js', () => ({
  executeSetupPluginCleanupOperator: mocks.executePluginCleanup,
}));
vi.mock('../core/control-capacity-client.js', () => ({
  previewSetupControlCapacity: mocks.previewCapacity,
  requestSetupControlCapacity: mocks.requestCapacity,
  retrySetupControlOperationStep: mocks.retryCapacity,
  listSetupExclusiveCapacityTenants: mocks.listCapacityTenants,
}));
vi.mock('../core/cloudflare.js', () => ({
  ensureSetupMachineAccessInD1: mocks.ensureSetupMachine,
  cleanupSetupMachineAccessInD1: mocks.cleanupSetupMachine,
  listD1Databases: mocks.listD1,
  assertR2BucketOwnershipForUse: mocks.assertR2Use,
}));
vi.mock('../core/worker-deployment-artifacts.js', () => ({
  refreshWorkerDeploymentArtifacts: mocks.refreshWorkerArtifacts,
}));

import { controlProvisionCommand } from '../cli/commands/control-provision.js';

const originalCwd = process.cwd();
let root: string;

const pending = {
  operationId: 'op_test_1',
  environmentId: 'test',
  operationKind: 'provision_shard',
  status: 'blocked',
  requestedByType: 'admin',
  attemptCount: 0,
  retryBudgetStartedAt: 100,
  createdAt: 100,
  updatedAt: 100,
  currentStep: 'create_d1',
  scope: 'tenant_exclusive',
  tenantId: 'tenant-1',
  dataRole: 'tenant_core/default',
  residencyPolicyId: 'builtin:residency:default',
  residencyPartition: 'default',
  databaseName: 'authrim-test-default-1234',
  desiredResourceId: 'desired-1',
  ownershipFingerprint: 'a'.repeat(64),
  shardId: 'shard-1',
  bindingRef: 'TDB_DEFAULT_1234_CORE',
  jurisdiction: null,
  locationHint: 'apac',
  readReplicationMode: 'disabled',
  migration: null,
} as const;

function fixedD1Lock() {
  return Object.fromEntries(
    D1_DATABASES.map((database) => [
      database.binding,
      {
        id:
          database.binding === 'CONTROL_DB'
            ? 'control-id'
            : database.binding === 'DB_ADMIN'
              ? 'admin-id'
              : `${database.binding.toLowerCase()}-id`,
        name: getD1DatabaseName('test', database.dbType),
      },
    ])
  );
}

async function writeEnvironment(): Promise<void> {
  const directory = join(root, '.authrim', 'test');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'authrim-test', version: '0.4.0' })}\n`
  );
  const config = createDefaultConfig('test');
  config.cloudflare = { accountId: 'account-1' };
  await writeFile(join(directory, 'config.json'), `${JSON.stringify(config)}\n`);
  await writeFile(
    join(directory, 'lock.json'),
    `${JSON.stringify({
      version: '1.0.0',
      env: 'test',
      createdAt: '2026-07-30T00:00:00.000Z',
      productVersion: '0.4.0',
      d1: fixedD1Lock(),
      kv: {},
      r2: {
        MIGRATION_RELEASES: {
          name: 'test-migration-releases',
          creationDate: '2026-08-31T00:00:00.000Z',
          ownershipMarkerKey:
            '__authrim_setup__/ownership-v1-11111111-1111-4111-8111-111111111111.json',
          ownershipId: '11111111-1111-4111-8111-111111111111',
        },
      },
    })}\n`
  );
}

async function updateEnvironmentLock(
  update: (lock: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const path = join(root, '.authrim', 'test', 'lock.json');
  const lock = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify(update(lock))}\n`);
}

describe('control-provision CLI command', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-control-provision-')));
    process.chdir(root);
    vi.clearAllMocks();
    mocks.spinner.start.mockReturnValue(mocks.spinner);
    mocks.listPending.mockResolvedValue([pending]);
    mocks.listPendingPlugin.mockResolvedValue([]);
    mocks.listPendingPluginCleanup.mockResolvedValue([]);
    mocks.listPendingTenantDr.mockResolvedValue([]);
    mocks.execute.mockResolvedValue({
      operationId: pending.operationId,
      state: 'awaiting_migration',
      errorCode: null,
      nextAttemptAt: null,
    });
    mocks.executeMigration.mockResolvedValue({
      operationId: pending.operationId,
      state: 'awaiting_worker_bindings',
      errorCode: null,
      nextAttemptAt: null,
    });
    mocks.executeBindings.mockResolvedValue({
      operationId: pending.operationId,
      state: 'awaiting_smoke',
      errorCode: null,
      nextAttemptAt: null,
    });
    mocks.previewCapacity.mockResolvedValue({
      dryRun: true,
      profile: 'recommended',
      scope: 'shared_pool',
      tenantId: null,
      available: true,
      reasonCode: null,
      capacityUnitsAdded: 1,
      d1DatabasesAdded: 1,
      projectedEnvironmentD1Count: 11,
      targets: [
        {
          operationId: 'capacity-op-1',
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          databaseName: 'authrim-test-users-default-capacity',
          workerScripts: ['test-ar-auth'],
        },
      ],
    });
    mocks.requestCapacity.mockResolvedValue({
      result: { operations: [{ operationId: 'capacity-op-1' }] },
      auditId: 'audit-1',
    });
    mocks.retryCapacity.mockResolvedValue({ state: 'provisioning' });
    mocks.ensureSetupMachine.mockResolvedValue({ success: true });
    mocks.cleanupSetupMachine.mockResolvedValue({ success: true });
    mocks.listD1.mockResolvedValue(
      Object.values(fixedD1Lock()).map((database) => ({
        name: database.name,
        uuid: database.id,
      }))
    );
    mocks.refreshWorkerArtifacts.mockResolvedValue({
      lock: {},
      generatedFiles: [],
      syncedComponents: ['ar-plugin-runner'],
    });
    await writeEnvironment();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  it('shows the server-owned plan without claiming it in dry-run mode', async () => {
    await controlProvisionCommand({ env: 'test', dryRun: true });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects a canonical config that belongs to another environment before Control access', async () => {
    const configPath = join(root, '.authrim', 'test', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.environment.prefix = 'another-environment';
    await writeFile(configPath, `${JSON.stringify(config)}\n`);

    await expect(controlProvisionCommand({ env: 'test', dryRun: true })).rejects.toThrow(
      'control_provision_config_environment_mismatch'
    );
    expect(mocks.listPending).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('executes the selected canonical operation without accepting topology inputs', async () => {
    await controlProvisionCommand({ env: 'test', operationId: pending.operationId, yes: true });
    expect(mocks.execute).toHaveBeenCalledWith({
      controlDatabaseId: 'control-id',
      operation: pending,
      expectedAccountId: 'account-1',
    });
    expect(mocks.spinner.succeed).toHaveBeenCalledWith(
      'D1 creation completed; the same operation is awaiting migration.'
    );
  });

  it('holds both mutation locks through execution and releases them after success', async () => {
    mocks.execute.mockImplementationOnce(async () => {
      await expect(
        acquireEnvironmentOperationForEnvironment({
          baseDir: root,
          env: 'test',
          operation: 'competing-environment-mutation',
          requireExisting: true,
        })
      ).rejects.toThrow('environment_operation_in_progress:control-provision:op_test_1');
      await expect(
        acquireDeployConfigLock({
          baseDir: root,
          env: 'other',
          operation: 'competing-deploy-config-mutation',
        })
      ).rejects.toThrow('deploy_config_operation_in_progress:control-provision:op_test_1');
      return {
        operationId: pending.operationId,
        state: 'awaiting_migration',
        errorCode: null,
        nextAttemptAt: null,
      };
    });

    await controlProvisionCommand({ env: 'test', operationId: pending.operationId, yes: true });

    const environmentLock = await acquireEnvironmentOperationForEnvironment({
      baseDir: root,
      env: 'test',
      operation: 'after-control-provision',
      requireExisting: true,
    });
    const deployConfigLock = await acquireDeployConfigLock({
      baseDir: root,
      env: 'test',
      operation: 'after-control-provision',
    });
    await deployConfigLock.release();
    await environmentLock.release();
  });

  it('performs zero mutations when a competing environment operation owns the lock', async () => {
    const competing = await acquireEnvironmentOperationForEnvironment({
      baseDir: root,
      env: 'test',
      operation: 'competing-delete',
      requireExisting: true,
    });
    try {
      await expect(
        controlProvisionCommand({
          env: 'test',
          capacityProfile: 'recommended',
          scope: 'shared_pool',
          dryRun: true,
        })
      ).rejects.toThrow('environment_operation_in_progress:competing-delete');
    } finally {
      await competing.release();
    }

    expect(mocks.ensureSetupMachine).not.toHaveBeenCalled();
    expect(mocks.previewCapacity).not.toHaveBeenCalled();
    expect(mocks.requestCapacity).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.refreshWorkerArtifacts).not.toHaveBeenCalled();
  });

  it('releases the environment lock when deploy-config lock acquisition loses a race', async () => {
    const competing = await acquireDeployConfigLock({
      baseDir: root,
      env: 'other',
      operation: 'competing-deploy',
    });
    try {
      await expect(
        controlProvisionCommand({ env: 'test', operationId: pending.operationId, yes: true })
      ).rejects.toThrow('deploy_config_operation_in_progress:competing-deploy');
    } finally {
      await competing.release();
    }
    expect(mocks.execute).not.toHaveBeenCalled();

    const environmentLock = await acquireEnvironmentOperationForEnvironment({
      baseDir: root,
      env: 'test',
      operation: 'after-deploy-config-race',
      requireExisting: true,
    });
    await environmentLock.release();
  });

  it('releases both locks when the canonical executor fails', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('operator_failed'));

    await expect(
      controlProvisionCommand({ env: 'test', operationId: pending.operationId, yes: true })
    ).rejects.toThrow('operator_failed');

    const environmentLock = await acquireEnvironmentOperationForEnvironment({
      baseDir: root,
      env: 'test',
      operation: 'after-operator-failure',
      requireExisting: true,
    });
    const deployConfigLock = await acquireDeployConfigLock({
      baseDir: root,
      env: 'test',
      operation: 'after-operator-failure',
    });
    await deployConfigLock.release();
    await environmentLock.release();
  });

  it.each([
    [
      'topology',
      'control_provision_topology_update_in_progress',
      {
        topologyUpdate: {
          kind: 'r2',
          phase: 'pending_deploy',
          targetProductVersion: '0.4.0',
          configChecksum: 'a'.repeat(64),
          authorizationTokenHash: 'b'.repeat(64),
          startedAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:01.000Z',
        },
      },
    ],
    [
      'release',
      'control_provision_release_update_in_progress',
      {
        releaseUpdate: {
          targetVersion: '0.4.0',
          phase: 'planned',
          manifestChecksum: 'c'.repeat(64),
          startedAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:01.000Z',
          appliedTargets: [],
          manualTargets: [],
        },
      },
    ],
  ])(
    're-reads and blocks a newly staged %s operation before mutation',
    async (_label, code, patch) => {
      mocks.listPending.mockImplementationOnce(async () => {
        await updateEnvironmentLock((lock) => ({ ...lock, ...patch }));
        return [pending];
      });

      await expect(
        controlProvisionCommand({ env: 'test', operationId: pending.operationId, yes: true })
      ).rejects.toThrow(code);

      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.executeMigration).not.toHaveBeenCalled();
      expect(mocks.executeBindings).not.toHaveBeenCalled();
      expect(mocks.refreshWorkerArtifacts).not.toHaveBeenCalled();
    }
  );

  it('applies the pinned migration through the migration executor', async () => {
    const digest = 'b'.repeat(64);
    const migrating = {
      ...pending,
      currentStep: 'apply_migrations',
      migration: {
        databaseId: 'database-id',
        streamId: 'd1-core',
        releaseId: '0.4.0',
        manifestDigest: digest,
        manifestObjectKey: `releases/0.4.0/${digest}/manifest.json`,
        generation: 1,
      },
    } as const;
    mocks.listPending.mockResolvedValue([migrating]);

    await controlProvisionCommand({ env: 'test', operationId: pending.operationId, yes: true });

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.executeMigration).toHaveBeenCalledWith({
      controlDatabaseId: 'control-id',
      migrationReleaseBucketName: 'test-migration-releases',
      operation: migrating,
      expectedAccountId: 'account-1',
      verifyMigrationReleaseBucketOwnership: expect.any(Function),
    });
    expect(mocks.spinner.succeed).toHaveBeenCalledWith(
      'Migration completed; the same operation is awaiting Worker binding reconciliation.'
    );
  });

  it('patches Worker bindings through the shared operator executor', async () => {
    const bindingOperation = {
      ...pending,
      currentStep: 'reconcile_worker_bindings',
      migration: {
        databaseId: 'database-id',
        streamId: 'd1-core',
        releaseId: '0.4.0',
        manifestDigest: 'b'.repeat(64),
        manifestObjectKey: `releases/0.4.0/${'b'.repeat(64)}/manifest.json`,
        generation: 1,
      },
    } as const;
    mocks.listPending.mockResolvedValue([bindingOperation]);

    await controlProvisionCommand({ env: 'test', operationId: pending.operationId, yes: true });

    expect(mocks.executeBindings).toHaveBeenCalledWith({
      controlDatabaseId: 'control-id',
      operation: bindingOperation,
      expectedAccountId: 'account-1',
      interTargetDelayMs: 15_000,
    });
    expect(mocks.spinner.succeed).toHaveBeenCalledWith(
      'Worker bindings patched; private smoke and stabilization are running.'
    );
  });

  it('uses locked DB_ADMIN identity for the safe Worker binding retry lifecycle', async () => {
    const bindingOperation = {
      ...pending,
      currentStep: 'reconcile_worker_bindings',
      lastErrorCode: 'control_worker_settings_request_rejected',
      migration: {
        databaseId: 'database-id',
        streamId: 'd1-core',
        releaseId: '0.4.0',
        manifestDigest: 'b'.repeat(64),
        manifestObjectKey: `releases/0.4.0/${'b'.repeat(64)}/manifest.json`,
        generation: 1,
      },
    } as const;
    mocks.listPending.mockResolvedValue([bindingOperation]);

    await controlProvisionCommand({ env: 'test', operationId: pending.operationId, yes: true });

    expect(mocks.retryCapacity).toHaveBeenCalledWith({
      apiBaseUrl: expect.any(String),
      keysDir: expect.any(String),
      operationId: pending.operationId,
      stepKey: 'reconcile_worker_bindings',
    });
    expect(mocks.ensureSetupMachine).toHaveBeenCalledWith(
      'test',
      expect.any(Object),
      expect.any(String),
      undefined,
      { databaseIdentifier: 'admin-id' }
    );
    expect(mocks.cleanupSetupMachine).toHaveBeenCalledWith('test', expect.any(String), undefined, {
      databaseIdentifier: 'admin-id',
    });
  });

  it('executes a pending plugin cleanup operation through the setup operator', async () => {
    const cleanupOperation = {
      operationId: 'cleanup-plugin-1',
      environmentId: 'test',
      operationKind: 'cleanup_plugin_resources',
      status: 'blocked',
      lastErrorCode: 'operator_action_required',
      attemptCount: 0,
      createdAt: 100,
      updatedAt: 100,
      pluginInstallationId: 'installation-1',
      tenantId: 'tenant-1',
      pluginId: 'plugin-a',
      sourceOperationId: 'source-1',
      lifecycleGeneration: 1,
      reason: 'uninstall',
      state: 'requested',
      workerScriptName: null,
      bindingNames: [],
      bindingPresenceRequired: false,
      drainNotBefore: null,
      currentStep: 'binding',
      resources: [],
    } as const;
    mocks.listPending.mockResolvedValue([]);
    mocks.listPendingPluginCleanup.mockResolvedValue([cleanupOperation]);
    mocks.executePluginCleanup.mockResolvedValue({
      operationId: cleanupOperation.operationId,
      state: 'awaiting_quarantine',
      errorCode: null,
      nextAttemptAt: 1900,
    });

    await controlProvisionCommand({
      env: 'test',
      operationId: cleanupOperation.operationId,
      yes: true,
    });

    expect(mocks.executePluginCleanup).toHaveBeenCalledWith({
      controlDatabaseId: 'control-id',
      operation: cleanupOperation,
      expectedAccountId: 'account-1',
    });
    expect(mocks.refreshWorkerArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        env: 'test',
        components: ['ar-plugin-runner'],
        registeredBy: 'setup:control-provision-plugin-resources',
      })
    );
    expect(mocks.spinner.succeed).toHaveBeenCalledWith(
      'Plugin bindings removed; cleanup is waiting for the quarantine drain.'
    );
  });

  it('previews and creates canonical capacity profile operations through Control', async () => {
    await controlProvisionCommand({
      env: 'test',
      capacityProfile: 'recommended',
      scope: 'shared_pool',
      yes: true,
    });

    expect(mocks.previewCapacity).toHaveBeenCalledWith({
      apiBaseUrl: expect.any(String),
      keysDir: expect.any(String),
      request: { profile: 'recommended', scope: 'shared_pool', tenantId: null },
    });
    expect(mocks.requestCapacity).toHaveBeenCalledWith({
      apiBaseUrl: expect.any(String),
      keysDir: expect.any(String),
      request: { profile: 'recommended', scope: 'shared_pool', tenantId: null },
    });
    expect(mocks.ensureSetupMachine).toHaveBeenCalledTimes(2);
    expect(mocks.cleanupSetupMachine).toHaveBeenCalledTimes(2);
    expect(mocks.ensureSetupMachine).toHaveBeenCalledWith(
      'test',
      expect.any(Object),
      expect.any(String),
      undefined,
      { databaseIdentifier: 'admin-id' }
    );
    expect(mocks.cleanupSetupMachine).toHaveBeenCalledWith('test', expect.any(String), undefined, {
      databaseIdentifier: 'admin-id',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('does not take the deploy-config lock for capacity-only work', async () => {
    const competing = await acquireDeployConfigLock({
      baseDir: root,
      env: 'other',
      operation: 'competing-worker-deploy',
    });
    try {
      await expect(
        controlProvisionCommand({
          env: 'test',
          capacityProfile: 'recommended',
          scope: 'shared_pool',
          dryRun: true,
        })
      ).resolves.toBeUndefined();
    } finally {
      await competing.release();
    }
    expect(mocks.previewCapacity).toHaveBeenCalledOnce();
  });

  it('performs zero capacity mutations when a fixed D1 UUID was replaced', async () => {
    mocks.listD1.mockResolvedValueOnce(
      Object.values(fixedD1Lock()).map((database) => ({
        name: database.name,
        uuid: database.id === 'admin-id' ? 'replacement-admin-id' : database.id,
      }))
    );

    await expect(
      controlProvisionCommand({
        env: 'test',
        capacityProfile: 'recommended',
        scope: 'shared_pool',
        dryRun: true,
      })
    ).rejects.toThrow('cloudflare_resource_identity_mismatch:D1:DB_ADMIN');

    expect(mocks.ensureSetupMachine).not.toHaveBeenCalled();
    expect(mocks.previewCapacity).not.toHaveBeenCalled();
    expect(mocks.requestCapacity).not.toHaveBeenCalled();
  });

  it('requires an exclusive tenant and keeps dry-run mutation free', async () => {
    await expect(
      controlProvisionCommand({
        env: 'test',
        capacityProfile: 'minimum',
        scope: 'tenant_exclusive',
        yes: true,
      })
    ).rejects.toThrow('control_capacity_tenant_required');

    await controlProvisionCommand({
      env: 'test',
      capacityProfile: 'recommended',
      scope: 'shared_pool',
      dryRun: true,
    });
    expect(mocks.previewCapacity).toHaveBeenCalledOnce();
    expect(mocks.requestCapacity).not.toHaveBeenCalled();
    expect(mocks.ensureSetupMachine).toHaveBeenCalledOnce();
    expect(mocks.cleanupSetupMachine).toHaveBeenCalledOnce();
  });

  it('cleans up temporary machine access when capacity preview fails', async () => {
    mocks.previewCapacity.mockRejectedValueOnce(new Error('capacity_preview_failed'));

    await expect(
      controlProvisionCommand({
        env: 'test',
        capacityProfile: 'recommended',
        scope: 'shared_pool',
        dryRun: true,
      })
    ).rejects.toThrow('capacity_preview_failed');

    expect(mocks.ensureSetupMachine).toHaveBeenCalledOnce();
    expect(mocks.cleanupSetupMachine).toHaveBeenCalledOnce();
  });

  it('does not report capacity success when temporary machine cleanup fails', async () => {
    mocks.cleanupSetupMachine.mockResolvedValueOnce({ success: false, error: 'cleanup_failed' });

    await expect(
      controlProvisionCommand({
        env: 'test',
        capacityProfile: 'recommended',
        scope: 'shared_pool',
        dryRun: true,
      })
    ).rejects.toThrow('control_setup_machine_cleanup_failed:cleanup_failed');
  });
});
