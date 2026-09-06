import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequiredR2Buckets } from '../core/cloudflare.js';
import { createDefaultConfig } from '../core/config.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';
import { acquireDeployConfigLock } from '../core/lock.js';
import {
  D1_DATABASES,
  KV_NAMESPACES,
  WORKER_COMPONENTS,
  getD1DatabaseName,
  getKVNamespaceName,
} from '../core/naming.js';
import { getEnvironmentPaths } from '../core/paths.js';
import { stagePendingControlBootstrap } from '../core/pending-control-bootstrap.js';
import {
  calculateReleaseManifestChecksum,
  calculateReleaseMigrationChecksum,
} from '../core/release-migrations.js';

const buildApiPackagesMock = vi.hoisted(() => vi.fn());
const deployAllMock = vi.hoisted(() => vi.fn());
const reconcileWorkerCronTriggersMock = vi.hoisted(() => vi.fn());
const deployAllUiWorkersMock = vi.hoisted(() => vi.fn());
const deployWorkerMock = vi.hoisted(() => vi.fn());
const deployUiWorkerBindingTargetsMock = vi.hoisted(() => vi.fn());
const resolveExistingWorkerComponentsMock = vi.hoisted(() => vi.fn());
const resolveMissingUiWorkerBindingTargetsMock = vi.hoisted(() => vi.fn());
const loadDeploySecretsFromKeysMock = vi.hoisted(() => vi.fn());
const getWorkersSubdomainMock = vi.hoisted(() => vi.fn());
const getWorkerDeploymentsMock = vi.hoisted(() => vi.fn());
const listD1DatabasesMock = vi.hoisted(() => vi.fn());
const listKVNamespacesMock = vi.hoisted(() => vi.fn());
const listQueuesMock = vi.hoisted(() => vi.fn());
const listR2BucketsMock = vi.hoisted(() => vi.fn());
const provisionR2BucketsMock = vi.hoisted(() => vi.fn());
const assertR2BucketOwnershipForUseMock = vi.hoisted(() => vi.fn());
const assertR2BucketOwnershipIdentityMock = vi.hoisted(() => vi.fn());
const listWorkersMock = vi.hoisted(() => vi.fn());
const getAccountIdMock = vi.hoisted(() => vi.fn());
const saveMasterWranglerConfigsMock = vi.hoisted(() => vi.fn());
const syncWranglerConfigsMock = vi.hoisted(() => vi.fn());
const buildWorkerHttpReadinessTargetsMock = vi.hoisted(() => vi.fn());
const waitForRouterWorkerReadyMock = vi.hoisted(() => vi.fn());
const waitForWorkerDeploymentsReadyMock = vi.hoisted(() => vi.fn());
const waitForWorkerHttpReadyMock = vi.hoisted(() => vi.fn());
const configureDownstreamIntrospectionDeploymentMock = vi.hoisted(() => vi.fn());
const ensureInitialControlPlaneResourcesMock = vi.hoisted(() => vi.fn());
const ensureInitialTenantRegionShardConfigMock = vi.hoisted(() => vi.fn());
const publishInitialControlPlaneRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
const ensureInitialNotificationProviderConfigurationMock = vi.hoisted(() => vi.fn());
const runMigrationsForEnvironmentMock = vi.hoisted(() => vi.fn());
const getD1MigrationStatusForEnvironmentMock = vi.hoisted(() => vi.fn());
const applyReleaseSchemaUpdatePlanMock = vi.hoisted(() => vi.fn());
const ensureInitialTenantInD1Mock = vi.hoisted(() => vi.fn());
const ensureInitialAdminRolesInD1Mock = vi.hoisted(() => vi.fn());
const ensureSetupMachineAccessInD1Mock = vi.hoisted(() => vi.fn());
const ensureAdminUiBffMachineAccessInD1Mock = vi.hoisted(() => vi.fn());
const cleanupSetupMachineAccessInD1Mock = vi.hoisted(() => vi.fn());
const seedDefaultCanonicalCatalogMock = vi.hoisted(() => vi.fn());
const seedRuntimeProfilesMock = vi.hoisted(() => vi.fn());
const ensureWildcardDnsForMultiTenantMock = vi.hoisted(() => vi.fn());
const prepareAdminUiBffDeploymentMock = vi.hoisted(() => vi.fn());
const publishAndActivateMigrationReleaseMock = vi.hoisted(() => vi.fn());
const compileControlWorkerInventoryFromArtifactsMock = vi.hoisted(() => vi.fn());
const registerControlWorkerInventoryMock = vi.hoisted(() => vi.fn());
const registerInitialControlTopologyMock = vi.hoisted(() => vi.fn());
const isInitialBootstrapHandoffAcceptedMock = vi.hoisted(() => vi.fn());
const advanceInitialBootstrapWorkerBindingsAsOperatorMock = vi.hoisted(() => vi.fn());
const reconcileInitialBootstrapHandoffAsOperatorMock = vi.hoisted(() => vi.fn());
const recordInitialBootstrapWorkerEvidenceMock = vi.hoisted(() => vi.fn());
const requestInitialBootstrapAccelerationMock = vi.hoisted(() => vi.fn());
const waitForInitialBootstrapHandoffMock = vi.hoisted(() => vi.fn());
const listInitialBootstrapReconciledWorkerVersionsMock = vi.hoisted(() => vi.fn());
const discoverExternalCapabilitiesMock = vi.hoisted(() => vi.fn());
const registerExternalCapabilitiesMock = vi.hoisted(() => vi.fn());
const publishDynamicPluginWorkerBundlesMock = vi.hoisted(() => vi.fn());
const queryD1RowsMock = vi.hoisted(() => vi.fn());
const completeControlTokenBootstrapMock = vi.hoisted(() => vi.fn());
const hasReadyControlTokenBootstrapMock = vi.hoisted(() => vi.fn());
const advanceReadyControlTokenGenerationMock = vi.hoisted(() => vi.fn());
const checkpointReadyControlTokenGenerationForRedeployMock = vi.hoisted(() => vi.fn());
const commitReadyControlTokenGenerationRedeployMock = vi.hoisted(() => vi.fn());
const initializeControlKeyStateMock = vi.hoisted(() => vi.fn());
const reconcileLocalControlKeyFilesMock = vi.hoisted(() => vi.fn());
const loadControlGeneratedKeyStateMock = vi.hoisted(() => vi.fn());
const loadControlStagedSigningKeysMock = vi.hoisted(() => vi.fn());
const projectControlGeneratedKeyStateMock = vi.hoisted(() => vi.fn());
const listPendingControlOperatorOperationsMock = vi.hoisted(() => vi.fn());
const listPendingPluginControlOperatorOperationsMock = vi.hoisted(() => vi.fn());
const listPendingPluginControlCleanupOperationsMock = vi.hoisted(() => vi.fn());
const listPendingTenantDisasterRecoveryOperatorOperationsMock = vi.hoisted(() => vi.fn());
const executeSetupControlOperatorCreateMock = vi.hoisted(() => vi.fn());
const executeSetupControlOperatorMigrationMock = vi.hoisted(() => vi.fn());
const executeSetupControlOperatorWorkerBindingsMock = vi.hoisted(() => vi.fn());
const executeSetupPluginControlOperatorMock = vi.hoisted(() => vi.fn());
const executeSetupPluginCleanupOperatorMock = vi.hoisted(() => vi.fn());
const retrySetupControlOperationStepMock = vi.hoisted(() => vi.fn());
const refreshWorkerDeploymentArtifactsMock = vi.hoisted(() => vi.fn());
const prepareManagedWorkerScriptOwnershipMock = vi.hoisted(() => vi.fn());
const assertLocalDeploymentCapacityMock = vi.hoisted(() => vi.fn());

vi.mock('../core/local-deployment-capacity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/local-deployment-capacity.js')>();
  return {
    ...actual,
    assertLocalDeploymentCapacity: assertLocalDeploymentCapacityMock,
  };
});

vi.mock('../core/deploy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/deploy.js')>();
  return {
    ...actual,
    buildApiPackages: buildApiPackagesMock,
    deployAll: async (...args: unknown[]) => {
      const summary = await deployAllMock(...args);
      return {
        ...summary,
        results: (summary.results ?? []).map((result: Record<string, unknown>, index: number) =>
          result.success === true
            ? {
                ...result,
                cloudflareVersionId:
                  result.cloudflareVersionId ??
                  `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
                cloudflareScriptTag:
                  result.cloudflareScriptTag ?? `immutable-api-worker-tag-${index + 1}`,
              }
            : result
        ),
      };
    },
    reconcileWorkerCronTriggers: reconcileWorkerCronTriggersMock,
    deployAllUiWorkers: async (...args: unknown[]) => {
      const summary = await deployAllUiWorkersMock(...args);
      return {
        ...summary,
        results: (summary.results ?? []).map((result: Record<string, unknown>, index: number) =>
          result.success === true
            ? {
                ...result,
                cloudflareVersionId:
                  result.cloudflareVersionId ??
                  `00000000-0000-4000-8002-${String(index + 1).padStart(12, '0')}`,
                cloudflareScriptTag:
                  result.cloudflareScriptTag ?? `immutable-ui-worker-tag-${index + 1}`,
              }
            : result
        ),
      };
    },
    deployWorker: async (...args: unknown[]) => {
      const result = await deployWorkerMock(...args);
      return result.success === true
        ? {
            ...result,
            cloudflareVersionId:
              result.cloudflareVersionId ?? '00000000-0000-4000-8004-000000000001',
            cloudflareScriptTag: result.cloudflareScriptTag ?? 'immutable-component-worker-tag',
          }
        : result;
    },
    deployUiWorkerBindingTargets: deployUiWorkerBindingTargetsMock,
    resolveExistingWorkerComponents: resolveExistingWorkerComponentsMock,
    resolveMissingUiWorkerBindingTargets: resolveMissingUiWorkerBindingTargetsMock,
    loadDeploySecretsFromKeys: loadDeploySecretsFromKeysMock,
  };
});

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    getWorkersSubdomain: getWorkersSubdomainMock,
    getWorkerDeployments: getWorkerDeploymentsMock,
    listD1Databases: listD1DatabasesMock,
    listKVNamespaces: listKVNamespacesMock,
    listQueues: listQueuesMock,
    listR2Buckets: listR2BucketsMock,
    provisionR2Buckets: provisionR2BucketsMock,
    assertR2BucketOwnershipForUse: assertR2BucketOwnershipForUseMock,
    assertR2BucketOwnershipIdentity: assertR2BucketOwnershipIdentityMock,
    listWorkers: listWorkersMock,
    getAccountId: getAccountIdMock,
    runMigrationsForEnvironment: runMigrationsForEnvironmentMock,
    getD1MigrationStatusForEnvironment: getD1MigrationStatusForEnvironmentMock,
    ensureInitialTenantInD1: ensureInitialTenantInD1Mock,
    ensureInitialAdminRolesInD1: ensureInitialAdminRolesInD1Mock,
    ensureSetupMachineAccessInD1: ensureSetupMachineAccessInD1Mock,
    ensureAdminUiBffMachineAccessInD1: ensureAdminUiBffMachineAccessInD1Mock,
    cleanupSetupMachineAccessInD1: cleanupSetupMachineAccessInD1Mock,
    seedDefaultCanonicalCatalog: seedDefaultCanonicalCatalogMock,
    seedRuntimeProfiles: seedRuntimeProfilesMock,
    ensureWildcardDnsForMultiTenant: ensureWildcardDnsForMultiTenantMock,
    queryD1Rows: queryD1RowsMock,
  };
});

vi.mock('../core/release-update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/release-update.js')>();
  return {
    ...actual,
    applyReleaseSchemaUpdatePlan: applyReleaseSchemaUpdatePlanMock,
  };
});

vi.mock('../core/wrangler-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/wrangler-sync.js')>();
  return {
    ...actual,
    saveMasterWranglerConfigs: saveMasterWranglerConfigsMock,
    syncWranglerConfigs: syncWranglerConfigsMock,
  };
});

vi.mock('../core/worker-readiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/worker-readiness.js')>();
  return {
    ...actual,
    buildWorkerHttpReadinessTargets: buildWorkerHttpReadinessTargetsMock,
    waitForRouterWorkerReady: waitForRouterWorkerReadyMock,
    waitForWorkerDeploymentsReady: waitForWorkerDeploymentsReadyMock,
    waitForWorkerHttpReady: waitForWorkerHttpReadyMock,
  };
});

vi.mock('../core/worker-script-ownership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/worker-script-ownership.js')>();
  return {
    ...actual,
    prepareManagedWorkerScriptOwnership: prepareManagedWorkerScriptOwnershipMock,
  };
});

vi.mock('../core/downstream-introspection-deploy.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/downstream-introspection-deploy.js')>();
  return {
    ...actual,
    configureDownstreamIntrospectionDeployment: configureDownstreamIntrospectionDeploymentMock,
  };
});

vi.mock('../core/control-plane-bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/control-plane-bootstrap.js')>();
  return {
    ...actual,
    ensureInitialControlPlaneResources: ensureInitialControlPlaneResourcesMock,
    ensureInitialTenantRegionShardConfig: ensureInitialTenantRegionShardConfigMock,
    publishInitialControlPlaneRuntimeSnapshot: publishInitialControlPlaneRuntimeSnapshotMock,
  };
});

vi.mock('../core/control-key-state.js', () => ({
  initializeControlKeyState: initializeControlKeyStateMock,
  reconcileLocalControlKeyFiles: reconcileLocalControlKeyFilesMock,
}));

vi.mock('../core/control-capacity-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/control-capacity-client.js')>();
  return {
    ...actual,
    retrySetupControlOperationStep: retrySetupControlOperationStepMock,
  };
});

vi.mock('../core/control-generated-state.js', () => ({
  loadControlGeneratedKeyState: loadControlGeneratedKeyStateMock,
  loadControlStagedSigningKeys: loadControlStagedSigningKeysMock,
  projectControlGeneratedKeyState: projectControlGeneratedKeyStateMock,
}));

vi.mock('../core/notification-provider-bootstrap.js', () => ({
  ensureInitialNotificationProviderConfiguration:
    ensureInitialNotificationProviderConfigurationMock,
}));

vi.mock('../core/admin-ui-bff-deployment.js', () => ({
  prepareAdminUiBffDeployment: prepareAdminUiBffDeploymentMock,
}));

vi.mock('../core/migration-release-publication.js', () => ({
  publishAndActivateMigrationRelease: publishAndActivateMigrationReleaseMock,
}));

vi.mock('../core/control-worker-inventory.js', () => ({
  compileControlWorkerInventoryFromArtifacts: compileControlWorkerInventoryFromArtifactsMock,
  registerControlWorkerInventory: registerControlWorkerInventoryMock,
}));

vi.mock('../core/control-bootstrap-handoff.js', () => ({
  registerInitialControlTopology: registerInitialControlTopologyMock,
  isInitialBootstrapHandoffAccepted: isInitialBootstrapHandoffAcceptedMock,
  advanceInitialBootstrapWorkerBindingsAsOperator:
    advanceInitialBootstrapWorkerBindingsAsOperatorMock,
  reconcileInitialBootstrapHandoffAsOperator: reconcileInitialBootstrapHandoffAsOperatorMock,
  recordInitialBootstrapWorkerEvidence: recordInitialBootstrapWorkerEvidenceMock,
  requestInitialBootstrapAcceleration: requestInitialBootstrapAccelerationMock,
  waitForInitialBootstrapHandoff: waitForInitialBootstrapHandoffMock,
  listInitialBootstrapReconciledWorkerVersions: listInitialBootstrapReconciledWorkerVersionsMock,
  workerVersionIdentity: (workerScriptName: string, versionId: string) =>
    `${workerScriptName}\0${versionId}`,
}));

vi.mock('../core/external-capability-registration.js', () => ({
  discoverExternalCapabilities: discoverExternalCapabilitiesMock,
  registerExternalCapabilities: registerExternalCapabilitiesMock,
}));

vi.mock('../core/dynamic-plugin-publication.js', () => ({
  publishDynamicPluginWorkerBundles: publishDynamicPluginWorkerBundlesMock,
}));

vi.mock('../core/control-token-bootstrap-orchestrator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/control-token-bootstrap-orchestrator.js')>();
  return {
    ...actual,
    completeControlTokenBootstrap: completeControlTokenBootstrapMock,
    hasReadyControlTokenBootstrap: hasReadyControlTokenBootstrapMock,
    advanceReadyControlTokenGeneration: advanceReadyControlTokenGenerationMock,
    checkpointReadyControlTokenGenerationForRedeploy:
      checkpointReadyControlTokenGenerationForRedeployMock,
    commitReadyControlTokenGenerationRedeploy: commitReadyControlTokenGenerationRedeployMock,
  };
});

vi.mock('../core/control-operator-operations.js', () => ({
  listPendingControlOperatorOperations: listPendingControlOperatorOperationsMock,
  listPendingPluginControlOperatorOperations: listPendingPluginControlOperatorOperationsMock,
  listPendingPluginControlCleanupOperations: listPendingPluginControlCleanupOperationsMock,
  listPendingTenantDisasterRecoveryOperatorOperations:
    listPendingTenantDisasterRecoveryOperatorOperationsMock,
}));

vi.mock('../core/control-operator-executor.js', () => ({
  executeSetupControlOperatorCreate: executeSetupControlOperatorCreateMock,
  executeSetupControlOperatorMigration: executeSetupControlOperatorMigrationMock,
  executeSetupControlOperatorWorkerBindings: executeSetupControlOperatorWorkerBindingsMock,
}));

vi.mock('../core/plugin-control-operator-executor.js', () => ({
  executeSetupPluginControlOperator: executeSetupPluginControlOperatorMock,
}));

vi.mock('../core/plugin-control-cleanup-operator-executor.js', () => ({
  executeSetupPluginCleanupOperator: executeSetupPluginCleanupOperatorMock,
}));

vi.mock('../core/worker-deployment-artifacts.js', () => ({
  refreshWorkerDeploymentArtifacts: refreshWorkerDeploymentArtifactsMock,
}));

import {
  buildWebInitialHandoffResumeSummary,
  createApiRoutes,
  generateSessionToken,
} from '../web/api.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;
let controlTokenBootstrapCompleted = false;
const TEST_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

function readyControlProvisioningAuthorityRow(environmentId = 'headless') {
  return {
    environment_id: environmentId,
    automatic_provisioning_enabled: 1,
    provisioning_token_ownership: 'account',
    provisioning_token_management: 'setup',
    provisioning_capability_state: 'ready',
    provisioning_capability_checked_at: 1_785_283_200,
    provisioning_bootstrap_phase: 'none',
    provisioning_bootstrap_token_ownership: 'none',
    provisioning_bootstrap_token_id: null,
    provisioning_bootstrap_token_fingerprint: null,
    provisioning_child_tokens_json: JSON.stringify([
      {
        resourceClass: 'd1',
        tokenId: '1'.repeat(32),
        tokenName: 'headless-d1',
        secretName: 'CLOUDFLARE_D1_API_TOKEN',
        tokenFingerprint: 'a'.repeat(64),
      },
      {
        resourceClass: 'workers',
        tokenId: '2'.repeat(32),
        tokenName: 'headless-workers',
        secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
        tokenFingerprint: 'b'.repeat(64),
      },
    ]),
    provisioning_secret_generation_deployment_id: 'secret-deployment',
    provisioning_secret_generation_version_id: '00000000-0000-4000-8000-000000000099',
    updated_at: 1_785_283_200,
  };
}

function tokenlessControlProvisioningAuthorityRow(environmentId: string) {
  return {
    environment_id: environmentId,
    automatic_provisioning_enabled: 1,
    provisioning_token_ownership: 'none',
    provisioning_token_management: 'none',
    provisioning_capability_state: 'pending',
    provisioning_capability_checked_at: null,
    provisioning_bootstrap_phase: 'none',
    provisioning_bootstrap_token_ownership: 'none',
    provisioning_bootstrap_token_id: null,
    provisioning_bootstrap_token_fingerprint: null,
    provisioning_child_tokens_json: null,
    provisioning_secret_generation_deployment_id: null,
    provisioning_secret_generation_version_id: null,
    updated_at: 100,
  };
}

async function stageRecoverableControlBootstrap(environment: string): Promise<void> {
  const bootstrapToken = 'staged-bootstrap-token-value-1234567890';
  await stagePendingControlBootstrap({
    baseDir: tempDir!,
    artifact: {
      version: 1,
      environment,
      accountId: TEST_ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken,
      bootstrapTokenId: '1'.repeat(32),
      bootstrapTokenFingerprint: createHash('sha256').update(bootstrapToken, 'utf8').digest('hex'),
      childTokens: [
        {
          resourceClass: 'd1',
          tokenId: '2'.repeat(32),
          tokenName: `authrim-${environment}-01234567-control-d1`,
          secretName: 'CLOUDFLARE_D1_API_TOKEN',
          tokenFingerprint: 'a'.repeat(64),
        },
        {
          resourceClass: 'workers',
          tokenId: '3'.repeat(32),
          tokenName: `authrim-${environment}-01234567-control-workers`,
          secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
          tokenFingerprint: 'b'.repeat(64),
        },
      ],
      secretGeneration: {
        deploymentId: 'deployment-staged',
        versionId: '00000000-0000-4000-8000-000000000099',
      },
      revocationTargetTokenIds: ['1'.repeat(32)],
      recoveryToken: null,
      revocationConfirmed: false,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const INITIAL_SCHEMA_STREAMS = [
  ['core-id', 'core-d1'],
  ['pii-id', 'pii-d1'],
  ['admin-id', 'admin-d1'],
  ['control-id', 'control-d1'],
  ['lookup-id', 'lookup-d1'],
  ['plugin-runner-id', 'plugin-runner-d1'],
] as const;

function successfulInitialSchemaResults(appliedCount = 0) {
  return INITIAL_SCHEMA_STREAMS.map(([databaseId, streamId]) => ({
    targetId: `d1:${databaseId}:${streamId}`,
    success: true,
    appliedCount,
    skippedCount: 0,
  }));
}

async function writeEnvironment(env: string) {
  const envDir = join(tempDir!, '.authrim', env);
  await mkdir(envDir, { recursive: true });
  const config = createDefaultConfig(env);
  config.controlPlane.automaticProvisioning = false;
  const releaseManifest = {
    formatVersion: 2 as const,
    productVersion: '0.2.0',
    streams: [
      {
        id: 'core-d1',
        schemaFamily: 'core',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['core', 'tenant_core'],
        files: [],
      },
      {
        id: 'pii-d1',
        schemaFamily: 'pii',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['pii', 'tenant_pii'],
        files: [],
      },
      {
        id: 'admin-d1',
        schemaFamily: 'admin',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['admin'],
        files: [],
      },
      {
        id: 'control-d1',
        schemaFamily: 'control',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['control'],
        files: [],
      },
      {
        id: 'lookup-d1',
        schemaFamily: 'lookup',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['lookup'],
        files: [],
      },
      {
        id: 'plugin-runner-d1',
        schemaFamily: 'plugin_runner',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['plugin_runner'],
        files: [],
      },
    ],
  };
  const manifestChecksum = calculateReleaseManifestChecksum(releaseManifest);
  await writeFile(join(envDir, 'config.json'), JSON.stringify(config, null, 2));
  await writeFile(
    join(envDir, 'lock.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        productVersion: '0.2.0',
        env,
        createdAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
        d1: {
          ...Object.fromEntries(
            D1_DATABASES.map((database) => [
              database.binding,
              {
                id: {
                  DB: 'core-id',
                  DB_PII: 'pii-id',
                  DB_ADMIN: 'admin-id',
                  CONTROL_DB: 'control-id',
                  LOOKUP_DB: 'lookup-id',
                  PLUGIN_RUNNER_DB: 'plugin-runner-id',
                }[database.binding],
                name: getD1DatabaseName(env, database.dbType),
              },
            ])
          ),
          TEST_TDB_DEFAULT_BOOTSTRAP_CORE: {
            id: 'bootstrap-default-id',
            name: `${env}-authrim-tenant-default-bootstrap-db`,
          },
          TEST_TDB_USERS_BOOTSTRAP_CORE: {
            id: 'bootstrap-users-id',
            name: `${env}-authrim-tenant-users-bootstrap-db`,
          },
          TEST_TDB_PII_BOOTSTRAP_PII: {
            id: 'bootstrap-pii-id',
            name: `${env}-authrim-tenant-pii-bootstrap-db`,
          },
        },
        kv: Object.fromEntries(
          KV_NAMESPACES.map((binding) => [
            binding,
            { id: `${binding.toLowerCase()}-id`, name: getKVNamespaceName(env, binding) },
          ])
        ),
        r2: {
          MIGRATION_RELEASES: { name: `${env}-migration-releases` },
        },
        schemaTargets: Object.fromEntries(
          [
            ['bootstrap-default-id', 'core-d1'],
            ['bootstrap-users-id', 'core-d1'],
            ['bootstrap-pii-id', 'pii-d1'],
          ].map(([databaseId, streamId]) => [
            `d1:${databaseId}:${streamId}`,
            {
              productVersion: '0.2.0',
              manifestChecksum,
              streamId,
              appliedBy: 'automatic',
              updatedAt: '2026-05-18T00:00:00.000Z',
            },
          ])
        ),
        workers: {
          'ar-auth': {
            name: `${env}-ar-auth`,
            deployedAt: '2026-05-18T00:00:00.000Z',
            version: '0.1.0',
            cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
            cloudflareScriptTag: 'immutable-ar-auth-tag',
          },
        },
      },
      null,
      2
    )}\n`
  );

  await writeFile(
    join(tempDir!, 'package.json'),
    `${JSON.stringify({ name: 'authrim-test', version: '0.2.0' }, null, 2)}\n`
  );

  const packageDir = join(tempDir!, 'packages', 'ar-auth');
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    `${JSON.stringify({ name: '@authrim/ar-auth', version: '0.2.0' }, null, 2)}\n`
  );

  const routerPackageDir = join(tempDir!, 'packages', 'ar-router');
  await mkdir(routerPackageDir, { recursive: true });
  await writeFile(
    join(routerPackageDir, 'package.json'),
    `${JSON.stringify({ name: '@authrim/ar-router', version: '0.3.0' }, null, 2)}\n`
  );

  const releasesDir = join(tempDir!, 'migrations', 'releases');
  await mkdir(releasesDir, { recursive: true });
  await writeFile(
    join(releasesDir, '0.2.0.json'),
    `${JSON.stringify(
      {
        formatVersion: 2,
        productVersion: '0.2.0',
        streams: releaseManifest.streams,
      },
      null,
      2
    )}\n`
  );
}

async function addVersionedWorkerPackage(
  env: string,
  component: string,
  deployedVersion: string,
  localVersion: string
) {
  const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
  lock.workers[component] = {
    name: `${env}-${component}`,
    deployedAt: '2026-05-18T00:00:00.000Z',
    version: deployedVersion,
    cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
    cloudflareScriptTag: `immutable-${component}-tag`,
  };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const packageDir = join(tempDir!, 'packages', component);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    `${JSON.stringify({ name: `@authrim/${component}`, version: localVersion }, null, 2)}\n`
  );
}

async function markEnvironmentProvisioned(env: string): Promise<void> {
  const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
  const value = JSON.parse(await readFile(lockPath, 'utf-8'));
  delete value.productVersion;
  value.workers = {};
  const d1Ids: Record<string, string> = {
    DB: 'core-id',
    DB_PII: 'pii-id',
    DB_ADMIN: 'admin-id',
    CONTROL_DB: 'control-id',
    LOOKUP_DB: 'lookup-id',
    PLUGIN_RUNNER_DB: 'plugin-runner-id',
  };
  value.d1 = Object.fromEntries(
    D1_DATABASES.map((database) => [
      database.binding,
      {
        id: d1Ids[database.binding],
        name: getD1DatabaseName(env, database.dbType),
      },
    ])
  );
  value.kv = Object.fromEntries(
    KV_NAMESPACES.map((binding) => [
      binding,
      { id: `${binding.toLowerCase()}-id`, name: getKVNamespaceName(env, binding) },
    ])
  );
  value.r2 = {
    MIGRATION_RELEASES: {
      name: `${env}-migration-releases`,
    },
  };
  await writeFile(lockPath, `${JSON.stringify(value, null, 2)}\n`);
}

const INITIAL_QUEUE_BINDINGS = [
  ['AUDIT_QUEUE', 'audit-queue'],
  ['LOGGING_DELIVERY_CRITICAL_QUEUE', 'logging-delivery-critical-queue'],
  ['LOGGING_DELIVERY_QUEUE', 'logging-delivery-queue'],
  ['LOGGING_DELIVERY_BULK_QUEUE', 'logging-delivery-bulk-queue'],
] as const;

async function enableQueuesForProvisionedEnvironment(env: string): Promise<void> {
  const configPath = join(tempDir!, '.authrim', env, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8'));
  config.features.queue.enabled = true;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
  lock.queues = Object.fromEntries(
    INITIAL_QUEUE_BINDINGS.map(([binding, suffix]) => [
      binding,
      { id: `queue-${binding.toLowerCase()}-id`, name: `${env}-${suffix}` },
    ])
  );
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  listQueuesMock.mockResolvedValue(
    INITIAL_QUEUE_BINDINGS.map(([binding, suffix]) => ({
      id: `queue-${binding.toLowerCase()}-id`,
      name: `${env}-${suffix}`,
    }))
  );
}

async function writeDraftManifest(version: string): Promise<void> {
  const migrationsDir = join(tempDir!, 'migrations');
  await mkdir(migrationsDir, { recursive: true });
  await writeFile(
    join(migrationsDir, 'release-manifest.draft.json'),
    `${JSON.stringify(
      {
        formatVersion: 2,
        productVersion: version,
        streams: [
          {
            id: 'core-d1',
            schemaFamily: 'core',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['core', 'tenant_core'],
            files: [],
          },
          {
            id: 'pii-d1',
            schemaFamily: 'pii',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['pii', 'tenant_pii'],
            files: [],
          },
          {
            id: 'admin-d1',
            schemaFamily: 'admin',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['admin'],
            files: [],
          },
          {
            id: 'control-d1',
            schemaFamily: 'control',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['control'],
            files: [],
          },
          {
            id: 'lookup-d1',
            schemaFamily: 'lookup',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['lookup'],
            files: [],
          },
          {
            id: 'plugin-runner-d1',
            schemaFamily: 'plugin_runner',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['plugin_runner'],
            files: [],
          },
        ],
      },
      null,
      2
    )}\n`
  );
}

async function prepareWebAppendOnlyDraftCheckpoint(env: string): Promise<{
  oldManifestChecksum: string;
  currentManifestChecksum: string;
}> {
  // Append-only recovery is deliberately limited to an unpublished development draft.
  await rm(join(tempDir!, 'migrations', 'releases', '0.2.0.json'), { force: true });
  const migrationDirectory = join(tempDir!, 'migrations', 'control', 'd1');
  const firstMigrationPath = join(migrationDirectory, '001_initial.sql');
  const appendedMigrationPath = join(migrationDirectory, '002_appended.sql');
  await mkdir(migrationDirectory, { recursive: true });
  await writeFile(firstMigrationPath, 'CREATE TABLE initial_state (id TEXT PRIMARY KEY);\n');
  await writeFile(appendedMigrationPath, 'ALTER TABLE initial_state ADD COLUMN value TEXT;\n');

  const draftPath = join(tempDir!, 'migrations', 'release-manifest.draft.json');
  const currentManifest = JSON.parse(await readFile(draftPath, 'utf-8'));
  const controlStream = currentManifest.streams.find(
    (stream: { id: string }) => stream.id === 'control-d1'
  );
  controlStream.files = [
    {
      path: '001_initial.sql',
      checksum: calculateReleaseMigrationChecksum(firstMigrationPath, 'sqlite'),
    },
    {
      path: '002_appended.sql',
      checksum: calculateReleaseMigrationChecksum(appendedMigrationPath, 'sqlite'),
    },
  ];
  await writeFile(draftPath, `${JSON.stringify(currentManifest, null, 2)}\n`);

  const oldManifest = structuredClone(currentManifest);
  oldManifest.streams.find((stream: { id: string }) => stream.id === 'control-d1').files.pop();
  const oldManifestChecksum = calculateReleaseManifestChecksum(oldManifest);
  const currentManifestChecksum = calculateReleaseManifestChecksum(currentManifest);
  const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
  const targetStreams = [
    ['DB', 'core-d1'],
    ['DB_PII', 'pii-d1'],
    ['DB_ADMIN', 'admin-d1'],
    ['CONTROL_DB', 'control-d1'],
    ['LOOKUP_DB', 'lookup-d1'],
    ['PLUGIN_RUNNER_DB', 'plugin-runner-d1'],
  ] as const;
  const targetIds: string[] = [];
  lock.schemaTargets = {};
  for (const [binding, streamId] of targetStreams) {
    const database = lock.d1[binding];
    const targetId = `d1:${database.id}:${streamId}`;
    targetIds.push(targetId);
    lock.schemaTargets[targetId] = {
      productVersion: '0.2.0',
      manifestChecksum: oldManifestChecksum,
      streamId,
      files: structuredClone(
        oldManifest.streams.find((stream: { id: string }) => stream.id === streamId).files
      ),
      appliedBy: 'automatic',
      updatedAt: '2026-05-18T00:01:00.000Z',
    };
  }
  lock.releaseUpdate = {
    targetVersion: '0.2.0',
    phase: 'schema_applied',
    manifestChecksum: oldManifestChecksum,
    startedAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:01:00.000Z',
    appliedTargets: targetIds,
    manualTargets: [],
  };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return { oldManifestChecksum, currentManifestChecksum };
}

async function configureControlPlaneWithoutBootstrapResources(env: string): Promise<void> {
  const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
  const currentLock = JSON.parse(await readFile(lockPath, 'utf-8'));
  delete currentLock.d1.TEST_TDB_DEFAULT_BOOTSTRAP_CORE;
  delete currentLock.d1.TEST_TDB_USERS_BOOTSTRAP_CORE;
  delete currentLock.d1.TEST_TDB_PII_BOOTSTRAP_PII;
  currentLock.schemaTargets = {};
  await writeFile(lockPath, `${JSON.stringify(currentLock, null, 2)}\n`);

  const releasesDir = join(tempDir!, 'migrations', 'releases');
  await mkdir(releasesDir, { recursive: true });
  await writeFile(
    join(releasesDir, '0.2.0.json'),
    `${JSON.stringify(
      {
        formatVersion: 2,
        productVersion: '0.2.0',
        streams: [
          {
            id: 'core-d1',
            schemaFamily: 'core',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['core', 'tenant_core'],
            files: [],
          },
          {
            id: 'pii-d1',
            schemaFamily: 'pii',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['pii', 'tenant_pii'],
            files: [],
          },
        ],
      },
      null,
      2
    )}\n`
  );
}

describe('setup web worker update API', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-web-worker-update-api-')));
    process.chdir(tempDir);
    controlTokenBootstrapCompleted = false;

    assertLocalDeploymentCapacityMock.mockReset().mockResolvedValue(2 * 1024 * 1024 * 1024);
    buildApiPackagesMock.mockReset();
    deployAllMock.mockReset();
    reconcileWorkerCronTriggersMock.mockReset().mockResolvedValue(undefined);
    deployAllUiWorkersMock.mockReset();
    deployWorkerMock.mockReset();
    deployUiWorkerBindingTargetsMock.mockReset();
    resolveExistingWorkerComponentsMock.mockReset();
    resolveMissingUiWorkerBindingTargetsMock.mockReset();
    loadDeploySecretsFromKeysMock.mockReset();
    getWorkersSubdomainMock.mockReset();
    getWorkerDeploymentsMock.mockReset();
    listD1DatabasesMock.mockReset();
    listKVNamespacesMock.mockReset();
    listQueuesMock.mockReset();
    listR2BucketsMock.mockReset();
    provisionR2BucketsMock.mockReset();
    assertR2BucketOwnershipForUseMock.mockReset();
    assertR2BucketOwnershipForUseMock.mockResolvedValue(undefined);
    assertR2BucketOwnershipIdentityMock.mockReset();
    assertR2BucketOwnershipIdentityMock.mockResolvedValue(undefined);
    listWorkersMock.mockReset();
    getAccountIdMock.mockReset();
    saveMasterWranglerConfigsMock.mockReset();
    syncWranglerConfigsMock.mockReset();
    buildWorkerHttpReadinessTargetsMock.mockReset();
    waitForRouterWorkerReadyMock.mockReset();
    waitForWorkerDeploymentsReadyMock.mockReset();
    waitForWorkerHttpReadyMock.mockReset();
    configureDownstreamIntrospectionDeploymentMock.mockReset();
    ensureInitialControlPlaneResourcesMock.mockReset();
    ensureInitialTenantRegionShardConfigMock.mockReset();
    publishInitialControlPlaneRuntimeSnapshotMock.mockReset();
    ensureInitialNotificationProviderConfigurationMock.mockReset();
    runMigrationsForEnvironmentMock.mockReset();
    getD1MigrationStatusForEnvironmentMock.mockReset();
    applyReleaseSchemaUpdatePlanMock.mockReset();
    ensureInitialTenantInD1Mock.mockReset();
    ensureInitialAdminRolesInD1Mock.mockReset();
    ensureSetupMachineAccessInD1Mock.mockReset();
    ensureAdminUiBffMachineAccessInD1Mock.mockReset();
    cleanupSetupMachineAccessInD1Mock.mockReset();
    seedDefaultCanonicalCatalogMock.mockReset();
    seedRuntimeProfilesMock.mockReset();
    ensureWildcardDnsForMultiTenantMock.mockReset();
    prepareAdminUiBffDeploymentMock.mockReset();
    publishAndActivateMigrationReleaseMock.mockReset();
    compileControlWorkerInventoryFromArtifactsMock.mockReset();
    registerControlWorkerInventoryMock.mockReset();
    registerInitialControlTopologyMock.mockReset();
    isInitialBootstrapHandoffAcceptedMock.mockReset();
    advanceInitialBootstrapWorkerBindingsAsOperatorMock.mockReset();
    reconcileInitialBootstrapHandoffAsOperatorMock.mockReset();
    recordInitialBootstrapWorkerEvidenceMock.mockReset();
    requestInitialBootstrapAccelerationMock.mockReset();
    waitForInitialBootstrapHandoffMock.mockReset();
    listInitialBootstrapReconciledWorkerVersionsMock.mockReset();
    discoverExternalCapabilitiesMock.mockReset();
    registerExternalCapabilitiesMock.mockReset();
    publishDynamicPluginWorkerBundlesMock.mockReset();
    queryD1RowsMock.mockReset();
    completeControlTokenBootstrapMock.mockReset();
    hasReadyControlTokenBootstrapMock.mockReset();
    advanceReadyControlTokenGenerationMock.mockReset();
    checkpointReadyControlTokenGenerationForRedeployMock.mockReset();
    commitReadyControlTokenGenerationRedeployMock.mockReset();
    initializeControlKeyStateMock.mockReset();
    reconcileLocalControlKeyFilesMock.mockReset();
    loadControlGeneratedKeyStateMock.mockReset();
    loadControlStagedSigningKeysMock.mockReset();
    projectControlGeneratedKeyStateMock.mockReset();
    listPendingControlOperatorOperationsMock.mockReset();
    listPendingPluginControlOperatorOperationsMock.mockReset();
    listPendingPluginControlCleanupOperationsMock.mockReset();
    listPendingTenantDisasterRecoveryOperatorOperationsMock.mockReset();
    executeSetupControlOperatorCreateMock.mockReset();
    executeSetupControlOperatorMigrationMock.mockReset();
    executeSetupControlOperatorWorkerBindingsMock.mockReset();
    executeSetupPluginControlOperatorMock.mockReset();
    executeSetupPluginCleanupOperatorMock.mockReset();
    retrySetupControlOperationStepMock.mockReset();
    refreshWorkerDeploymentArtifactsMock.mockReset();
    prepareManagedWorkerScriptOwnershipMock.mockReset();

    getD1MigrationStatusForEnvironmentMock.mockResolvedValue({
      env: 'test',
      success: true,
      databases: [],
    });

    buildApiPackagesMock.mockResolvedValue({ success: true });
    deployAllUiWorkersMock.mockResolvedValue({
      successCount: 0,
      failedCount: 0,
      results: [],
    });
    deployWorkerMock.mockResolvedValue({
      success: true,
      workerName: 'test-ar-router',
      version: '0.3.0',
      deployedAt: '2026-06-18T00:00:00.000Z',
      cloudflareVersionId: '00000000-0000-4000-8003-000000000001',
      cloudflareScriptTag: 'immutable-worker-tag',
    });
    prepareManagedWorkerScriptOwnershipMock.mockImplementation(async ({ lock }) => ({
      lock,
      changed: false,
      guard: {
        assertBeforeMutation: async () => undefined,
        checkpointCommittedVersion: async () => undefined,
        captureAfterMutation: async () => 'immutable-worker-tag',
        getEvidence: (workerName: string) => ({
          workerName,
          state: 'owned' as const,
          tag: 'immutable-worker-tag',
        }),
      },
    }));
    listWorkersMock.mockImplementation(async () => {
      const authrimDirectory = join(tempDir!, '.authrim');
      const environments = await readdir(authrimDirectory).catch(() => [] as string[]);
      const scripts: Array<{ name: string; id: string; tag: string }> = [];
      for (const environment of environments) {
        const lock = JSON.parse(
          await readFile(join(authrimDirectory, environment, 'lock.json'), 'utf-8').catch(
            () => '{}'
          )
        ) as {
          workers?: Record<string, { name?: string; cloudflareScriptTag?: string }>;
        };
        for (const worker of Object.values(lock.workers ?? {})) {
          if (worker.name && worker.cloudflareScriptTag) {
            scripts.push({
              name: worker.name,
              id: worker.name,
              tag: worker.cloudflareScriptTag,
            });
          }
        }
      }
      return scripts;
    });
    deployUiWorkerBindingTargetsMock.mockResolvedValue({
      successCount: 0,
      failedCount: 0,
      results: [],
    });
    resolveExistingWorkerComponentsMock.mockImplementation(
      async (_options, components: string[]) => [...components]
    );
    resolveMissingUiWorkerBindingTargetsMock.mockResolvedValue({ loginUi: true, adminUi: true });
    resolveExistingWorkerComponentsMock.mockImplementation(
      async (options) => options.existingComponents ?? []
    );
    loadDeploySecretsFromKeysMock.mockResolvedValue({
      FLOW_RUNTIME_HMAC_SECRET: 'flow-runtime-secret',
      PLUGIN_ENCRYPTION_KEY: 'plugin-encryption-key',
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-v1',
      SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
      CLOUDFLARE_D1_API_TOKEN: 'd1-token',
      CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
    });
    getWorkersSubdomainMock.mockResolvedValue('example-subdomain');
    getAccountIdMock.mockResolvedValue(TEST_ACCOUNT_ID);
    getWorkerDeploymentsMock.mockImplementation(async (name: string) => ({
      name,
      exists: true,
      lastDeployedAt: '2026-05-18T00:00:00.000Z',
      author: 'test@example.com',
      versionId:
        controlTokenBootstrapCompleted && name.endsWith('-ar-control')
          ? '00000000-0000-4000-8000-000000000099'
          : '00000000-0000-4000-8000-000000000001',
      source: 'Upload',
    }));
    listD1DatabasesMock.mockImplementation(async () =>
      ['test', 'headless'].flatMap((environment) => [
        ...D1_DATABASES.map((database) => ({
          uuid: {
            DB: 'core-id',
            DB_PII: 'pii-id',
            DB_ADMIN: 'admin-id',
            CONTROL_DB: 'control-id',
            LOOKUP_DB: 'lookup-id',
            PLUGIN_RUNNER_DB: 'plugin-runner-id',
          }[database.binding],
          name: getD1DatabaseName(environment, database.dbType),
        })),
        {
          uuid: 'bootstrap-default-id',
          name: `${environment}-authrim-tenant-default-bootstrap-db`,
        },
        {
          uuid: 'bootstrap-users-id',
          name: `${environment}-authrim-tenant-users-bootstrap-db`,
        },
        {
          uuid: 'bootstrap-pii-id',
          name: `${environment}-authrim-tenant-pii-bootstrap-db`,
        },
      ])
    );
    listKVNamespacesMock.mockImplementation(async () =>
      ['test', 'headless'].flatMap((environment) =>
        KV_NAMESPACES.map((binding) => ({
          id: `${binding.toLowerCase()}-id`,
          title: getKVNamespaceName(environment, binding),
        }))
      )
    );
    listQueuesMock.mockResolvedValue([]);
    listR2BucketsMock.mockResolvedValue(
      ['test', 'headless'].flatMap((environment) => [
        { name: `${environment}-migration-releases` },
        { name: `authrim-${environment}-migration-releases` },
        { name: `${environment}-plugin-bundles` },
        { name: `${environment}-public-assets` },
        { name: `${environment}-diagnostic-logs` },
        { name: `${environment}-audit-archive` },
        { name: `${environment}-import-artifacts` },
        { name: `${environment}-export-artifacts` },
        { name: `${environment}-sensitive-details` },
      ])
    );
    queryD1RowsMock.mockImplementation(async (_databaseName, sql: string) =>
      controlTokenBootstrapCompleted && sql.includes('provisioning_token_management')
        ? [readyControlProvisioningAuthorityRow()]
        : []
    );
    listInitialBootstrapReconciledWorkerVersionsMock.mockResolvedValue(new Set());
    saveMasterWranglerConfigsMock.mockResolvedValue({ success: true, errors: [] });
    syncWranglerConfigsMock.mockResolvedValue({ success: true, errors: [], synced: ['ar-auth'] });
    buildWorkerHttpReadinessTargetsMock.mockReturnValue([]);
    waitForRouterWorkerReadyMock.mockResolvedValue({ ready: true });
    waitForWorkerDeploymentsReadyMock.mockResolvedValue({ ready: true });
    waitForWorkerHttpReadyMock.mockResolvedValue({ ready: true });
    configureDownstreamIntrospectionDeploymentMock.mockResolvedValue({ success: true });
    ensureInitialControlPlaneResourcesMock.mockResolvedValue({ success: true, skipped: true });
    ensureInitialTenantRegionShardConfigMock.mockResolvedValue({ created: true, config: {} });
    publishInitialControlPlaneRuntimeSnapshotMock.mockResolvedValue({
      success: true,
      skipped: true,
    });
    ensureInitialNotificationProviderConfigurationMock.mockResolvedValue({
      providerId: null,
      namespaces: ['authrim-platform', 'test'],
    });
    discoverExternalCapabilitiesMock.mockResolvedValue([]);
    registerExternalCapabilitiesMock.mockResolvedValue({
      operationId: 'op-external',
      aggregateDigest: 'a'.repeat(64),
      sourceCount: 0,
      sql: '',
    });
    publishDynamicPluginWorkerBundlesMock.mockResolvedValue({ published: [] });
    completeControlTokenBootstrapMock.mockImplementation(async () => {
      controlTokenBootstrapCompleted = true;
    });
    hasReadyControlTokenBootstrapMock.mockResolvedValue(false);
    advanceReadyControlTokenGenerationMock.mockResolvedValue(undefined);
    checkpointReadyControlTokenGenerationForRedeployMock.mockResolvedValue(null);
    commitReadyControlTokenGenerationRedeployMock.mockResolvedValue(undefined);
    initializeControlKeyStateMock.mockResolvedValue({
      initialized: true,
      operationId: null,
      fingerprints: null,
    });
    reconcileLocalControlKeyFilesMock.mockResolvedValue(undefined);
    loadControlGeneratedKeyStateMock.mockResolvedValue({
      runtimeRegistry: {
        activeSlot: 'A',
        activeKeyId: 'runtime-test',
        activeFingerprint: 'a'.repeat(64),
        updatedAt: 1,
      },
      smokeRpc: {
        activeSlot: 'A',
        activeKeyId: 'smoke-test',
        activeFingerprint: 'b'.repeat(64),
        updatedAt: 1,
      },
      lookupHmac: {
        stateRevision: 1,
        activeGeneration: 1,
        activeSlot: 'A',
        activeKeyId: 'lookup-test',
        activeFingerprint: 'c'.repeat(64),
        updatedAt: 1,
      },
    });
    loadControlStagedSigningKeysMock.mockResolvedValue([]);
    projectControlGeneratedKeyStateMock.mockImplementation((lock, state) => ({
      lock: { ...lock, controlKeyState: state },
      changed: true,
    }));
    listPendingControlOperatorOperationsMock.mockResolvedValue([]);
    listPendingPluginControlOperatorOperationsMock.mockResolvedValue([]);
    listPendingPluginControlCleanupOperationsMock.mockResolvedValue([]);
    listPendingTenantDisasterRecoveryOperatorOperationsMock.mockResolvedValue([]);
    runMigrationsForEnvironmentMock.mockResolvedValue({
      success: true,
      core: { success: true, appliedCount: 0, skippedCount: 0 },
      pii: { success: true, appliedCount: 0, skippedCount: 0 },
      admin: { success: true, appliedCount: 0, skippedCount: 0 },
    });
    applyReleaseSchemaUpdatePlanMock.mockResolvedValue({
      success: true,
      results: successfulInitialSchemaResults(),
    });
    ensureInitialTenantInD1Mock.mockResolvedValue({ success: true });
    ensureInitialAdminRolesInD1Mock.mockResolvedValue({ success: true });
    ensureSetupMachineAccessInD1Mock.mockResolvedValue({ success: true });
    ensureAdminUiBffMachineAccessInD1Mock.mockResolvedValue({ success: true });
    cleanupSetupMachineAccessInD1Mock.mockResolvedValue({ success: true });
    seedDefaultCanonicalCatalogMock.mockResolvedValue({ success: true, seededCount: 0 });
    seedRuntimeProfilesMock.mockResolvedValue({
      success: true,
      seededCount: 0,
      backend: 'D1',
    });
    ensureWildcardDnsForMultiTenantMock.mockResolvedValue(undefined);
    publishAndActivateMigrationReleaseMock.mockResolvedValue({
      artifact: { releaseId: '0.2.0', streamIds: ['core-d1', 'pii-d1', 'lookup-d1'] },
      operationId: 'release-op',
    });
    compileControlWorkerInventoryFromArtifactsMock.mockResolvedValue([
      { workerScriptName: 'test-ar-auth' },
    ]);
    registerControlWorkerInventoryMock.mockResolvedValue(undefined);
    registerInitialControlTopologyMock.mockResolvedValue({
      ownershipFingerprint: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
    });
    isInitialBootstrapHandoffAcceptedMock.mockResolvedValue(false);
    recordInitialBootstrapWorkerEvidenceMock.mockResolvedValue({
      workerCount: 1,
      controlDeploymentId: 'deployment-control',
      controlVersionId: 'version-control',
    });
    waitForInitialBootstrapHandoffMock.mockResolvedValue({ state: 'accepted', acceptedAt: 100 });
    requestInitialBootstrapAccelerationMock.mockResolvedValue('accepted');
    retrySetupControlOperationStepMock.mockResolvedValue({ status: 'pending' });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('rejects caller-selected filesystem roots on every deployment and migration mutation', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    for (const [path, body] of [
      ['/deploy', { env: 'test', rootDir: '/tmp/untrusted' }],
      ['/deploy/component/ar-auth', { env: 'test', rootDir: '/tmp/untrusted' }],
      ['/migrations/run', { env: 'test', rootDir: '/tmp/untrusted' }],
      ['/migrations/apply', { env: 'test', role: 'core', rootDir: '/tmp/untrusted' }],
    ] as const) {
      const response = await app.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': token,
        },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(400);
    }
    expect(buildApiPackagesMock).not.toHaveBeenCalled();
    expect(runMigrationsForEnvironmentMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('publishes worker update progress while the update request is still running', async () => {
    const env = 'test';
    await writeEnvironment(env);

    const deployRelease = deferred<void>();
    const deployStarted = deferred<void>();
    deployAllMock.mockImplementation(async (options) => {
      options.onProgress('Deploying ar-auth...');
      deployStarted.resolve();
      await deployRelease.promise;
      options.onProgress('✓ test-ar-auth deployed');
      return {
        totalComponents: 1,
        successCount: 1,
        failedCount: 0,
        results: [
          {
            component: 'ar-auth',
            workerName: 'test-ar-auth',
            version: '0.2.0',
            deployedAt: '2026-06-18T00:00:00.000Z',
            success: true,
          },
        ],
      };
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const updateRequest = app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true }),
    });

    await deployStarted.promise;

    const statusResponse = await app.request('/deploy/status');
    const statusBody = (await statusResponse.json()) as {
      status: string;
      progress: string[];
      deploymentProgress: unknown;
    };

    expect(statusBody.status).toBe('deploying');
    expect(statusBody.progress).toContain('Starting worker update for environment: test');
    expect(statusBody.progress).toContain('Deploying ar-auth...');
    expect(statusBody.deploymentProgress).toBeNull();

    deployRelease.resolve();

    const updateResponse = await updateRequest;
    const updateBody = (await updateResponse.json()) as {
      success: boolean;
      progress: string[];
    };

    expect(updateResponse.status).toBe(200);
    expect(updateBody.success).toBe(true);
    expect(updateBody.progress).toContain('✓ test-ar-auth deployed');
  });

  it('requires the schema-first update route when the product version changes', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await writeFile(
      join(tempDir!, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.3.0' }, null, 2)}\n`
    );

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      requiredCommand: 'authrim-setup update --env test',
    });
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('does not create missing tenant databases during a Worker-only redeploy', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await configureControlPlaneWithoutBootstrapResources(env);

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: false }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      topologyIssues: [
        { binding: 'TEST_TDB_DEFAULT_BOOTSTRAP_CORE', reason: 'missing_binding' },
        { binding: 'TEST_TDB_USERS_BOOTSTRAP_CORE', reason: 'missing_binding' },
        { binding: 'TEST_TDB_PII_BOOTSTRAP_PII', reason: 'missing_binding' },
      ],
    });
    expect(ensureInitialControlPlaneResourcesMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('does not let a request body spoof a Control Plane topology operation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await configureControlPlaneWithoutBootstrapResources(env);

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: false, operationKind: 'topology_change' }),
    });
    expect(response.status).toBe(409);
    expect(ensureInitialControlPlaneResourcesMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('keeps the initial Web deploy route from redeploying an existing environment', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      requiredCommand: 'authrim-setup update --env test',
    });
    expect(buildApiPackagesMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('exposes a recovery path for an interrupted initial deployment', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const app = createApiRoutes();
    const response = await app.request('/deploy/recovery/test');
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      env,
      configExists: true,
      status: 'resumable',
      canResume: true,
      resumeFrom: 'database_migrations',
    });
  });

  it('does not offer resume when a lock-recorded Cloudflare resource is missing', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    listD1DatabasesMock.mockResolvedValue(
      (await listD1DatabasesMock.getMockImplementation()!()).filter(
        (database: { uuid: string }) => database.uuid !== 'core-id'
      )
    );

    const response = await createApiRoutes().request('/deploy/recovery/test');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'recreate_required',
      canResume: false,
      requiresRecreate: true,
      reasonCode: 'cloudflare_resource_checkpoint_mismatch',
    });
  });

  it('does not offer resume when a required R2 bucket is missing', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    listR2BucketsMock.mockResolvedValue([]);

    const response = await createApiRoutes().request('/deploy/recovery/test');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'recreate_required',
      canResume: false,
      requiresRecreate: true,
      reasonCode: 'cloudflare_resource_checkpoint_mismatch',
    });
    expect(assertR2BucketOwnershipIdentityMock).not.toHaveBeenCalled();
  });

  it('does not offer resume when an R2 ownership marker no longer matches', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    assertR2BucketOwnershipIdentityMock.mockRejectedValueOnce(
      new Error('R2 ownership marker does not match test-migration-releases')
    );

    const response = await createApiRoutes().request('/deploy/recovery/test');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'recreate_required',
      canResume: false,
      requiresRecreate: true,
      reasonCode: 'cloudflare_resource_checkpoint_mismatch',
    });
  });

  it('temporarily blocks resume when R2 ownership verification is unavailable', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    assertR2BucketOwnershipIdentityMock.mockRejectedValueOnce(
      new Error('Cloudflare R2 ownership marker read failed (503)')
    );

    const response = await createApiRoutes().request('/deploy/recovery/test');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'blocked',
      canResume: false,
      requiresRecreate: false,
      reasonCode: 'cloudflare_resource_verification_unavailable',
    });
  });

  it('temporarily blocks resume when Cloudflare resource verification is unavailable', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    listD1DatabasesMock.mockRejectedValue(new Error('Cloudflare API temporarily unavailable'));

    const response = await createApiRoutes().request('/deploy/recovery/test');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'blocked',
      canResume: false,
      requiresRecreate: false,
      reasonCode: 'cloudflare_resource_verification_unavailable',
    });
  });

  it('does not offer resume when a same-name Worker has no ownership checkpoint', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    listWorkersMock.mockResolvedValue([
      { name: 'test-ar-auth', id: 'test-ar-auth', tag: 'replacement-script-tag' },
    ]);

    const response = await createApiRoutes().request('/deploy/recovery/test');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'recreate_required',
      canResume: false,
      requiresRecreate: true,
      reasonCode: 'worker_ownership_checkpoint_mismatch',
    });
  });

  it('offers explicit Web recovery for an orphan created in the sibling upload window', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.cloudflare.accountId = TEST_ACCOUNT_ID;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.workerScriptOwnership = {
      'ar-auth': {
        name: 'test-ar-auth',
        cloudflareScriptTag: 'immutable-ar-auth-tag',
        state: 'provisional',
        updatedAt: '2026-05-18T00:02:00.000Z',
      },
    };
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'schema_applied',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:01:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    listWorkersMock.mockResolvedValue([
      { name: 'test-ar-auth', id: 'test-ar-auth', tag: 'immutable-ar-auth-tag' },
      { name: 'test-ar-router', id: 'test-ar-router', tag: 'immutable-ar-router-tag' },
    ]);
    getWorkerDeploymentsMock.mockImplementation(async (name: string) => ({
      name,
      exists: true,
      lastDeployedAt: '2026-05-18T00:02:30.000Z',
      author: 'test@example.com',
      versionId: '00000000-0000-4000-8000-000000000001',
      source: 'Upload',
    }));

    const response = await createApiRoutes().request('/deploy/recovery/test');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'resumable',
      canResume: true,
      requiresRecreate: false,
      resumeFrom: 'worker_deployment',
      requiresWorkerOwnershipRecovery: true,
      workerOwnershipRecoveryComponents: ['ar-router'],
    });
  });

  it('persists explicit orphan ownership before continuing the Web deployment', async () => {
    const env = 'headless';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.cloudflare.accountId = TEST_ACCOUNT_ID;
    config.controlPlane.automaticProvisioning = false;
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifest = JSON.parse(
      await readFile(join(tempDir!, 'migrations', 'releases', '0.2.0.json'), 'utf-8')
    );
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'schema_applied',
      manifestChecksum: calculateReleaseManifestChecksum(manifest),
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:01:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    lock.workerScriptOwnership = {
      'ar-auth': {
        name: `${env}-ar-auth`,
        cloudflareScriptTag: 'immutable-ar-auth-tag',
        state: 'provisional',
        updatedAt: '2026-05-18T00:02:00.000Z',
      },
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    listWorkersMock.mockResolvedValue([
      { name: `${env}-ar-auth`, id: `${env}-ar-auth`, tag: 'immutable-ar-auth-tag' },
      { name: `${env}-ar-router`, id: `${env}-ar-router`, tag: 'immutable-ar-router-tag' },
    ]);
    getWorkerDeploymentsMock.mockImplementation(async (name: string) => ({
      name,
      exists: true,
      lastDeployedAt: '2026-05-18T00:02:30.000Z',
      author: 'test@example.com',
      versionId: '00000000-0000-4000-8000-000000000001',
      source: 'Upload',
    }));
    buildApiPackagesMock.mockResolvedValueOnce({
      success: false,
      error: 'intentional stop after ownership recovery',
    });

    const session = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': session,
      },
      body: JSON.stringify({ env, recoverWorkerOwnership: true }),
    });

    expect(response.status).toBe(500);
    const persisted = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(persisted.workers['ar-router']).toMatchObject({
      name: `${env}-ar-router`,
      version: '0.2.0',
      cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
      cloudflareScriptTag: 'immutable-ar-router-tag',
    });
  });

  it('does not offer resume when a lock-recorded Worker is missing', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.workerScriptOwnership = {
      'ar-auth': {
        name: 'test-ar-auth',
        cloudflareScriptTag: 'immutable-ar-auth-tag',
        state: 'provisional',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
    };
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    listWorkersMock.mockResolvedValue([]);

    const response = await createApiRoutes().request('/deploy/recovery/test');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'recreate_required',
      canResume: false,
      requiresRecreate: true,
      reasonCode: 'worker_ownership_checkpoint_mismatch',
    });
  });

  it('resumes from Worker deployment only when Control Plane tenant schemas are registered', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'schema_applied',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const app = createApiRoutes();
    const response = await app.request('/deploy/recovery/test');
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      status: 'resumable',
      resumeFrom: 'worker_deployment',
      reasonCode: 'schema_checkpoint_verified',
      completedSteps: {
        schemaApplied: true,
        controlPlaneReady: true,
        workersDeployed: false,
      },
    });
  });

  it('reports incomplete Control Plane tenant migrations before offering Worker deployment', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifestChecksum = Object.values(lock.schemaTargets)[0]?.manifestChecksum;
    delete lock.productVersion;
    delete lock.d1.TEST_TDB_USERS_BOOTSTRAP_CORE;
    lock.workers = {};
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'schema_applied',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const app = createApiRoutes();
    const response = await app.request('/deploy/recovery/test');
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      status: 'resumable',
      canResume: true,
      resumeFrom: 'control_plane_bootstrap',
      reasonCode: 'initial_control_plane_bootstrap_incomplete',
      incompleteControlPlaneBindings: ['TEST_TDB_USERS_BOOTSTRAP_CORE'],
      completedSteps: {
        schemaApplied: true,
        controlPlaneReady: false,
        workersDeployed: false,
      },
    });
  });

  it('enables post-deploy recovery only after every locked Worker version is verified remotely', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.controlPlane.automaticProvisioning = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifest = JSON.parse(
      await readFile(join(tempDir!, 'migrations', 'releases', '0.2.0.json'), 'utf-8')
    );
    const manifestChecksum = calculateReleaseManifestChecksum(manifest);
    delete lock.productVersion;
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'workers_deployed',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    lock.workers = Object.fromEntries(
      WORKER_COMPONENTS.map((component) => [
        component,
        {
          name: `${env}-${component}`,
          deployedAt: '2026-05-18T00:00:00.000Z',
          version: '0.2.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
          cloudflareScriptTag: `immutable-${component}-tag`,
        },
      ])
    );
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    hasReadyControlTokenBootstrapMock.mockResolvedValue(true);
    getWorkerDeploymentsMock.mockImplementation(async (name: string) => ({
      name,
      exists: true,
      lastDeployedAt: '2026-05-18T00:00:00.000Z',
      author: 'test@example.com',
      versionId:
        name === 'test-ar-control'
          ? '00000000-0000-4000-8000-000000000002'
          : '00000000-0000-4000-8000-000000000001',
      source: name === 'test-ar-control' ? 'Secret Change' : 'Upload',
    }));

    const app = createApiRoutes();
    const response = await app.request('/deploy/recovery/test');
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      status: 'resumable',
      canResume: true,
      requiresRecreate: false,
      resumeFrom: 'post_deploy_verification',
      requiresBootstrapToken: false,
      completedSteps: {
        resourcesProvisioned: true,
        schemaApplied: true,
        workersDeployed: true,
        verificationComplete: false,
      },
    });
    expect(getWorkerDeploymentsMock).toHaveBeenCalledTimes(WORKER_COMPONENTS.length);
  });

  it('disables recovery when a locked Worker version no longer matches Cloudflare', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifest = JSON.parse(
      await readFile(join(tempDir!, 'migrations', 'releases', '0.2.0.json'), 'utf-8')
    );
    delete lock.productVersion;
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'workers_deployed',
      manifestChecksum: calculateReleaseManifestChecksum(manifest),
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    lock.workers = Object.fromEntries(
      WORKER_COMPONENTS.map((component) => [
        component,
        {
          name: `${env}-${component}`,
          deployedAt: '2026-05-18T00:00:00.000Z',
          version: '0.2.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
          cloudflareScriptTag: `immutable-${component}-tag`,
        },
      ])
    );
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    getWorkerDeploymentsMock.mockResolvedValueOnce({
      name: 'test-ar-lib-core',
      exists: true,
      lastDeployedAt: '2026-05-18T00:00:00.000Z',
      author: 'test@example.com',
      versionId: '00000000-0000-4000-8000-000000000002',
    });

    const app = createApiRoutes();
    const response = await app.request('/deploy/recovery/test');
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      status: 'recreate_required',
      canResume: false,
      requiresRecreate: true,
      reasonCode: 'remote_worker_checkpoint_mismatch',
    });
  });

  it('keeps recovery enabled for a Worker version created by binding reconciliation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifest = JSON.parse(
      await readFile(join(tempDir!, 'migrations', 'releases', '0.2.0.json'), 'utf-8')
    );
    delete lock.productVersion;
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'workers_deployed',
      manifestChecksum: calculateReleaseManifestChecksum(manifest),
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    lock.workers = Object.fromEntries(
      WORKER_COMPONENTS.map((component) => [
        component,
        {
          name: `${env}-${component}`,
          deployedAt: '2026-05-18T00:00:00.000Z',
          version: '0.2.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
          cloudflareScriptTag: `immutable-${component}-tag`,
        },
      ])
    );
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const reconciledVersion = '00000000-0000-4000-8000-000000000002';
    listInitialBootstrapReconciledWorkerVersionsMock.mockResolvedValue(
      new Set([`test-ar-lib-core\0${reconciledVersion}`])
    );
    getWorkerDeploymentsMock.mockImplementation(async (name: string) => ({
      name,
      exists: true,
      lastDeployedAt: '2026-05-18T00:00:00.000Z',
      author: 'test@example.com',
      versionId:
        name === 'test-ar-lib-core' ? reconciledVersion : '00000000-0000-4000-8000-000000000001',
      source: 'Upload',
    }));

    const response = await createApiRoutes().request('/deploy/recovery/test');
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      status: 'resumable',
      canResume: true,
      requiresRecreate: false,
      resumeFrom: 'post_deploy_verification',
    });
  });

  it('reuses remotely verified Control secrets when resuming an existing Worker handoff', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = true;
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifest = JSON.parse(
      await readFile(join(tempDir!, 'migrations', 'releases', '0.2.0.json'), 'utf-8')
    );
    delete lock.productVersion;
    const manifestChecksum = calculateReleaseManifestChecksum(manifest);
    const streamByBinding = new Map([
      ['DB', 'core-d1'],
      ['DB_PII', 'pii-d1'],
      ['DB_ADMIN', 'admin-d1'],
      ['CONTROL_DB', 'control-d1'],
      ['LOOKUP_DB', 'lookup-d1'],
      ['PLUGIN_RUNNER_DB', 'plugin-runner-d1'],
    ]);
    const appliedTargets: string[] = [];
    lock.schemaTargets = {};
    for (const [binding, streamId] of streamByBinding) {
      const targetId = `d1:${lock.d1[binding].id}:${streamId}`;
      appliedTargets.push(targetId);
      lock.schemaTargets[targetId] = {
        productVersion: '0.2.0',
        manifestChecksum,
        streamId,
        files: manifest.streams.find((stream: { id: string }) => stream.id === streamId).files,
        appliedBy: 'automatic',
        updatedAt: '2026-05-18T00:10:00.000Z',
      };
    }
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'workers_deployed',
      manifestChecksum,
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
      appliedTargets,
      manualTargets: [],
    };
    lock.workers = Object.fromEntries(
      WORKER_COMPONENTS.map((component) => [
        component,
        {
          name: `${env}-${component}`,
          deployedAt: '2026-05-18T00:00:00.000Z',
          version: '0.2.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
          cloudflareScriptTag: `immutable-${component}-tag`,
        },
      ])
    );
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    hasReadyControlTokenBootstrapMock.mockResolvedValue(true);
    loadDeploySecretsFromKeysMock.mockResolvedValue({
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-v1',
      SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
    });
    applyReleaseSchemaUpdatePlanMock.mockResolvedValue({
      success: false,
      results: [{ targetId: 'd1:control-id:control-d1', success: false, error: 'test stop' }],
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({ success: true });
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(publishAndActivateMigrationReleaseMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('completes a pre-authority staged Control bootstrap without another Web token', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = true;
    config.cloudflare.accountId = TEST_ACCOUNT_ID;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.workers['ar-control'] = {
      name: `${env}-ar-control`,
      deployedAt: '2026-08-31T00:00:00.000Z',
      version: '0.2.0',
      cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
      cloudflareScriptTag: 'immutable-ar-control-tag',
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await stageRecoverableControlBootstrap(env);
    queryD1RowsMock.mockImplementation(async (_databaseName, sql: string) => {
      if (!sql.includes('provisioning_token_management')) return [];
      return controlTokenBootstrapCompleted
        ? [readyControlProvisioningAuthorityRow(env)]
        : [tokenlessControlProvisioningAuthorityRow(env)];
    });

    const session = generateSessionToken();
    const response = await createApiRoutes().request('/control/automatic-provisioning/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': session,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ env }),
    });
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({ success: true });
    expect(completeControlTokenBootstrapMock).toHaveBeenCalledOnce();
    expect(completeControlTokenBootstrapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        environment: env,
        ownership: 'account',
      })
    );
    expect(completeControlTokenBootstrapMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'bootstrapToken'
    );
  });

  it('requires recreation when the draft manifest changed during initial deployment', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');

    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = true;
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    hasReadyControlTokenBootstrapMock.mockResolvedValue(true);

    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'workers_deployed',
      manifestChecksum: 'f'.repeat(64),
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const app = createApiRoutes();
    const response = await app.request('/deploy/recovery/test');
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      status: 'recreate_required',
      canResume: false,
      requiresRecreate: true,
      reasonCode: 'initial_manifest_changed',
    });
    expect(deployAllMock).not.toHaveBeenCalled();
    expect(hasReadyControlTokenBootstrapMock).not.toHaveBeenCalled();
  });

  it('preserves append-only draft evidence after a Web migration failure and advances it on retry', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = false;
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const { oldManifestChecksum, currentManifestChecksum } =
      await prepareWebAppendOnlyDraftCheckpoint(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    applyReleaseSchemaUpdatePlanMock.mockResolvedValueOnce({
      success: false,
      results: [
        {
          targetId: 'd1:control-id:control-d1',
          success: false,
          appliedCount: 1,
          skippedCount: 0,
          error: 'injected_transient_failure',
        },
      ],
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const request = () =>
      app.request('/deploy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': token,
        },
        body: JSON.stringify({ env, skipBuild: true, runMigrations: true }),
      });
    const firstResponse = await request();
    expect(firstResponse.status).toBe(500);
    expect(
      applyReleaseSchemaUpdatePlanMock,
      JSON.stringify(await firstResponse.clone().json())
    ).toHaveBeenCalledOnce();

    const failedCheckpoint = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(failedCheckpoint.releaseUpdate).toMatchObject({
      phase: 'schema_applied',
      manifestChecksum: oldManifestChecksum,
    });
    expect(failedCheckpoint.schemaTargets['d1:control-id:control-d1']).toMatchObject({
      manifestChecksum: oldManifestChecksum,
      files: [expect.objectContaining({ path: '001_initial.sql' })],
    });

    applyReleaseSchemaUpdatePlanMock.mockImplementationOnce(async () => {
      const checkpointAtRetry = JSON.parse(await readFile(lockPath, 'utf-8'));
      expect(checkpointAtRetry.releaseUpdate).toMatchObject({
        phase: 'schema_applied',
        manifestChecksum: oldManifestChecksum,
      });
      return {
        success: true,
        results: successfulInitialSchemaResults().map((result) =>
          result.targetId === 'd1:control-id:control-d1'
            ? { ...result, appliedCount: 1, skippedCount: 1 }
            : result
        ),
      };
    });
    publishAndActivateMigrationReleaseMock.mockRejectedValueOnce(
      new Error('injected_stop_after_schema_checkpoint')
    );

    const retryResponse = await request();
    expect(retryResponse.status).toBe(500);
    expect(applyReleaseSchemaUpdatePlanMock).toHaveBeenCalledTimes(2);
    expect(deployAllMock).not.toHaveBeenCalled();
    const retriedCheckpoint = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(retriedCheckpoint.releaseUpdate).toMatchObject({
      phase: 'schema_applied',
      manifestChecksum: currentManifestChecksum,
    });
    expect(retriedCheckpoint.schemaTargets['d1:control-id:control-d1']).toMatchObject({
      manifestChecksum: currentManifestChecksum,
      files: [
        expect.objectContaining({ path: '001_initial.sql' }),
        expect.objectContaining({ path: '002_appended.sql' }),
      ],
    });
  });

  it('rejects manifest-changed deployment before build or Cloudflare Worker mutation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');

    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = false;
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'workers_deployed',
      manifestChecksum: 'f'.repeat(64),
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    lock.workers = Object.fromEntries(
      WORKER_COMPONENTS.map((component) => [
        component,
        {
          name: `${env}-${component}`,
          deployedAt: '2026-05-18T00:00:00.000Z',
          version: '0.2.0',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
          cloudflareScriptTag: `immutable-${component}-tag`,
        },
      ])
    );
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env }),
    });
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(409);
    expect(responseBody).toMatchObject({
      success: false,
    });
    expect(String(responseBody.error)).toContain('Delete this incomplete environment');
    expect(buildApiPackagesMock).not.toHaveBeenCalled();
    expect(getWorkerDeploymentsMock).not.toHaveBeenCalled();
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('recovers exact immutable Web handoff evidence without redeploying Worker traffic', async () => {
    const getDeployment = vi.fn(async (workerName: string) => ({
      name: workerName,
      exists: true,
      lastDeployedAt: '2026-08-11T11:49:00.000Z',
      author: 'setup@example.test',
      versionId:
        workerName === 'test-ar-auth'
          ? '00000000-0000-4000-8000-000000000001'
          : '00000000-0000-4000-8000-000000000002',
    }));
    const lock = JSON.parse(
      JSON.stringify({
        version: '1.0.0',
        env: 'test',
        createdAt: '2026-08-11T11:00:00.000Z',
        updatedAt: '2026-08-11T11:49:00.000Z',
        d1: {},
        kv: {},
        workers: {
          'ar-auth': {
            name: 'test-ar-auth',
            deployedAt: '2026-08-11T11:48:00.000Z',
            version: '0.4.0',
            cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
            cloudflareScriptTag: 'immutable-auth-tag',
          },
          'ar-token': {
            name: 'test-ar-token',
            deployedAt: '2026-08-11T11:48:30.000Z',
            version: '0.4.0',
            cloudflareVersionId: '00000000-0000-4000-8000-000000000002',
            cloudflareScriptTag: 'immutable-token-tag',
          },
        },
        releaseUpdate: {
          targetVersion: '0.4.0',
          phase: 'schema_applied',
          manifestChecksum: 'a'.repeat(64),
          startedAt: '2026-08-11T11:00:00.000Z',
          updatedAt: '2026-08-11T11:30:00.000Z',
          appliedTargets: [],
          manualTargets: [],
        },
      })
    );
    const listScripts = vi.fn(async () => [
      { name: 'test-ar-auth', id: 'test-ar-auth', tag: 'immutable-auth-tag' },
      { name: 'test-ar-token', id: 'test-ar-token', tag: 'immutable-token-tag' },
    ]);

    const summary = await buildWebInitialHandoffResumeSummary({
      lock,
      components: ['ar-auth', 'ar-token'],
      productVersion: '0.4.0',
      getDeployment,
      listScripts,
      now: '2026-08-11T12:00:00.000Z',
    });

    expect(summary).toMatchObject({
      successCount: 2,
      failedCount: 0,
      results: [
        {
          workerName: 'test-ar-auth',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
        },
        {
          workerName: 'test-ar-token',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000002',
        },
      ],
    });
    expect(getDeployment).toHaveBeenCalledTimes(2);

    listScripts.mockResolvedValueOnce([
      { name: 'test-ar-auth', id: 'test-ar-auth', tag: 'foreign-recreated-tag' },
      { name: 'test-ar-token', id: 'test-ar-token', tag: 'immutable-token-tag' },
    ]);
    await expect(
      buildWebInitialHandoffResumeSummary({
        lock,
        components: ['ar-auth', 'ar-token'],
        productVersion: '0.4.0',
        getDeployment,
        listScripts,
      })
    ).rejects.toThrow('initial_handoff_resume_script_identity_mismatch:ar-auth');
    expect(getDeployment).toHaveBeenCalledTimes(2);

    lock.releaseUpdate.initialWorkerRedeployRequired = true;
    await expect(
      buildWebInitialHandoffResumeSummary({
        lock,
        components: ['ar-auth', 'ar-token'],
        productVersion: '0.4.0',
        getDeployment,
        listScripts,
      })
    ).resolves.toBeNull();
    expect(getDeployment).toHaveBeenCalledTimes(2);
    delete lock.releaseUpdate.initialWorkerRedeployRequired;

    delete lock.workers['ar-token'];
    await expect(
      buildWebInitialHandoffResumeSummary({
        lock,
        components: ['ar-auth', 'ar-token'],
        productVersion: '0.4.0',
        getDeployment,
        listScripts,
      })
    ).resolves.toBeNull();

    lock.workers['ar-token'] = {
      name: 'test-ar-token',
      deployedAt: '2026-08-11T11:48:30.000Z',
      version: '0.4.0',
      cloudflareVersionId: '00000000-0000-4000-8000-000000000002',
      cloudflareScriptTag: 'immutable-token-tag',
    };
    getDeployment.mockResolvedValueOnce({
      name: 'test-ar-auth',
      exists: false,
      lastDeployedAt: null,
      author: null,
      versionId: null,
    });
    await expect(
      buildWebInitialHandoffResumeSummary({
        lock,
        components: ['ar-auth', 'ar-token'],
        productVersion: '0.4.0',
        getDeployment,
        listScripts,
      })
    ).rejects.toThrow('initial_handoff_resume_remote_evidence_missing:ar-auth');
  });

  it('acquires the environment lock before initial deployment build work begins', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    const buildStarted = deferred<void>();
    const finishBuild = deferred<void>();
    buildApiPackagesMock.mockImplementation(async () => {
      buildStarted.resolve();
      await finishBuild.promise;
      return { success: false, error: 'intentional test stop' };
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const deployment = app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env }),
    });

    await buildStarted.promise;
    const operationLockPath = join(tempDir!, '.authrim', env, 'lock.json.operation-lock');
    await expect(readFile(operationLockPath, 'utf-8')).resolves.toContain('web-initial-deploy');

    finishBuild.resolve();
    expect((await deployment).status).toBe(500);
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: 'error',
      deploymentProgress: {
        operation: 'deploy',
        status: 'error',
        message: expect.stringContaining('failed'),
      },
    });
    await expect(readFile(operationLockPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns an actionable 507 response when the initial build has insufficient disk space', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    buildApiPackagesMock.mockResolvedValue({
      success: false,
      errorCode: 'insufficient_local_disk_space',
      error:
        'Insufficient local disk space for package build: 144 MiB available; at least 1 GiB is required.',
    });

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env }),
    });

    expect(response.status).toBe(507);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'insufficient_local_disk_space',
      requiredAction: 'free_local_disk_space_and_retry',
      error: expect.stringContaining('144 MiB available'),
    });
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('rejects a same-name replacement D1 before Web schema or Worker mutation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    const databases = (await listD1DatabasesMock()) as Array<{ uuid: string; name: string }>;
    listD1DatabasesMock.mockResolvedValue(
      databases.map((database) =>
        database.name === 'test-authrim-core-db'
          ? { ...database, uuid: 'replacement-core-id' }
          : database
      )
    );

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ env, skipBuild: true, runMigrations: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'cloudflare_resource_identity_mismatch',
      resources: [{ type: 'D1', binding: 'DB', name: 'test-authrim-core-db' }],
    });
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
    expect(ensureInitialTenantInD1Mock).not.toHaveBeenCalled();
    expect(ensureInitialAdminRolesInD1Mock).not.toHaveBeenCalled();
    expect(ensureSetupMachineAccessInD1Mock).not.toHaveBeenCalled();
    expect(cleanupSetupMachineAccessInD1Mock).not.toHaveBeenCalled();
    expect(ensureAdminUiBffMachineAccessInD1Mock).not.toHaveBeenCalled();
    expect(seedDefaultCanonicalCatalogMock).not.toHaveBeenCalled();
    expect(seedRuntimeProfilesMock).not.toHaveBeenCalled();
    expect(prepareAdminUiBffDeploymentMock).not.toHaveBeenCalled();
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.d1.DB.id).toBe('core-id');
  });

  it('rejects a same-name replacement KV before Web schema or Worker mutation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    const namespaces = (await listKVNamespacesMock()) as Array<{ id: string; title: string }>;
    listKVNamespacesMock.mockResolvedValue(
      namespaces.map((namespace) =>
        namespace.title === 'TEST-SETTINGS'
          ? { ...namespace, id: 'replacement-settings-id' }
          : namespace
      )
    );

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ env, skipBuild: true, runMigrations: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'cloudflare_resource_identity_mismatch',
      resources: [{ type: 'KV', binding: 'SETTINGS', name: 'TEST-SETTINGS' }],
    });
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.kv.SETTINGS.id).toBe('settings-id');
  });

  it('cleans the exact DB_ADMIN after Web setup machine registration loses its response', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = false;
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    deployAllMock.mockResolvedValue({
      totalComponents: WORKER_COMPONENTS.length,
      successCount: WORKER_COMPONENTS.length,
      failedCount: 0,
      results: WORKER_COMPONENTS.map((component) => ({
        component,
        workerName: `${env}-${component}`,
        version: '0.2.0',
        deployedAt: '2026-08-31T00:00:00.000Z',
        success: true,
      })),
    });
    ensureSetupMachineAccessInD1Mock.mockRejectedValueOnce(
      new Error('setup_machine_registration_response_lost')
    );

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ env, skipBuild: true, runMigrations: true }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('setup_machine_registration_response_lost'),
    });
    expect(cleanupSetupMachineAccessInD1Mock).toHaveBeenCalledWith(
      env,
      expect.any(String),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
  });

  it('rejects a same-name replacement Queue before Web schema or Worker mutation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await enableQueuesForProvisionedEnvironment(env);
    await writeDraftManifest('0.2.0');
    const queues = (await listQueuesMock()) as Array<{ id: string; name: string }>;
    listQueuesMock.mockResolvedValue(
      queues.map((queue) =>
        queue.name === 'test-audit-queue' ? { ...queue, id: 'queue-replacement-id' } : queue
      )
    );

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ env, skipBuild: true, runMigrations: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'cloudflare_resource_identity_mismatch',
      resources: [
        {
          type: 'Queue',
          binding: 'AUDIT_QUEUE',
          name: 'test-audit-queue',
          reason: 'live_identity_mismatch',
        },
      ],
    });
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.queues.AUDIT_QUEUE.id).toBe('queue-audit_queue-id');
  });

  it('rejects Queue inventory without immutable IDs before Web mutation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await enableQueuesForProvisionedEnvironment(env);
    await writeDraftManifest('0.2.0');
    const queues = (await listQueuesMock()) as Array<{ id?: string; name: string }>;
    listQueuesMock.mockResolvedValue(
      queues.map((queue) => (queue.name === 'test-audit-queue' ? { name: queue.name } : queue))
    );

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ env, skipBuild: true, runMigrations: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'cloudflare_resource_identity_mismatch',
      resources: [
        {
          type: 'Queue',
          binding: 'AUDIT_QUEUE',
          reason: 'live_identity_unavailable',
        },
      ],
    });
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('rejects a missing migration release R2 bucket before Web schema mutation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    listR2BucketsMock.mockResolvedValue([]);

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify({ env, skipBuild: true, runMigrations: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'required_cloudflare_resources_missing',
      resources: expect.arrayContaining([
        { type: 'R2', binding: 'MIGRATION_RELEASES', name: 'test-migration-releases' },
      ]),
    });
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(publishAndActivateMigrationReleaseMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('preserves exact R2 ownership evidence when provisioning buckets from the Web UI', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const before = JSON.parse(await readFile(lockPath, 'utf-8'));
    before.r2 = {};
    await writeFile(lockPath, `${JSON.stringify(before, null, 2)}\n`);
    const ownershipId = '00000000-0000-4000-8000-000000000123';
    provisionR2BucketsMock.mockResolvedValue([
      {
        binding: 'MIGRATION_RELEASES',
        name: `${env}-migration-releases`,
        creationDate: '2026-09-04T00:00:00.000Z',
        ownershipMarkerKey: `__authrim_setup__/ownership-v1-${ownershipId}.json`,
        ownershipId,
      },
    ]);

    const token = generateSessionToken();
    const response = await createApiRoutes().request(`/r2/${env}/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: '{}',
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.r2.MIGRATION_RELEASES).toEqual({
      name: `${env}-migration-releases`,
      creationDate: '2026-09-04T00:00:00.000Z',
      ownershipMarkerKey: `__authrim_setup__/ownership-v1-${ownershipId}.json`,
      ownershipId,
    });
  });

  it('requires environment recreation when the legacy R2 ownership set is incomplete', async () => {
    const env = 'test';
    await writeEnvironment(env);

    const token = generateSessionToken();
    const response = await createApiRoutes().request(`/r2/${env}/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: '{}',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'r2_legacy_ownership_requires_environment_recreation',
      bindings: ['MIGRATION_RELEASES'],
      requiresRecreate: true,
    });
    expect(provisionR2BucketsMock).not.toHaveBeenCalled();
  });

  it('offers CLI adoption when every required legacy R2 bucket still exists', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const requiredBuckets = getRequiredR2Buckets(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.r2 = Object.fromEntries(
      requiredBuckets.map((bucket) => [bucket.binding, { name: bucket.name }])
    );
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    listR2BucketsMock.mockResolvedValueOnce(
      requiredBuckets.map((bucket) => ({
        name: bucket.name,
        creationDate: '2026-09-04T00:00:00.000Z',
      }))
    );

    const token = generateSessionToken();
    const response = await createApiRoutes().request(`/r2/${env}/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: '{}',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'r2_legacy_ownership_requires_explicit_adoption',
      bindings: requiredBuckets.map((bucket) => bucket.binding),
      requiresRecreate: false,
      requiredCommand: expect.stringContaining('--adopt-legacy-r2-ownership --yes'),
    });
    expect(provisionR2BucketsMock).not.toHaveBeenCalled();
  });

  it('blocks Web R2 provisioning when the locked environment identity does not match', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.env = 'other';
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const token = generateSessionToken();
    const response = await createApiRoutes().request(`/r2/${env}/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: '{}',
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Lock environment identity mismatch: expected test, found other',
    });
    expect(provisionR2BucketsMock).not.toHaveBeenCalled();
  });

  it('blocks Web R2 provisioning when the config belongs to another environment', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.r2 = {};
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.environment.prefix = 'other';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const token = generateSessionToken();
    const response = await createApiRoutes().request(`/r2/${env}/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: '{}',
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'r2_provision_config_environment_mismatch',
    });
    expect(provisionR2BucketsMock).not.toHaveBeenCalled();
  });

  it('completes a schema-first initial Web deployment with automatic provisioning', async () => {
    const env = 'headless';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    await rm(join(tempDir!, 'packages'), { recursive: true, force: true });
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = true;
    config.cloudflare.accountId = 'account-id';
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    configureDownstreamIntrospectionDeploymentMock.mockRejectedValueOnce(
      new Error('optional introspection provider unavailable')
    );

    const events: string[] = [];
    applyReleaseSchemaUpdatePlanMock.mockImplementation(async () => {
      events.push('schema');
      return {
        success: true,
        results: successfulInitialSchemaResults(),
      };
    });
    resolveMissingUiWorkerBindingTargetsMock.mockResolvedValue({
      loginUi: false,
      adminUi: false,
    });
    buildWorkerHttpReadinessTargetsMock.mockReturnValue([
      {
        workerName: `${env}-ar-auth`,
        url: `https://${env}-ar-auth.example-subdomain.workers.dev/api/auth/health`,
      },
    ]);
    publishAndActivateMigrationReleaseMock.mockImplementation(async () => {
      events.push('release');
      return {
        artifact: { releaseId: '0.2.0', streamIds: ['core-d1', 'pii-d1', 'lookup-d1'] },
        operationId: 'release-op',
      };
    });
    registerControlWorkerInventoryMock.mockImplementation(async () => {
      events.push('inventory');
    });
    registerInitialControlTopologyMock.mockImplementation(async () => {
      events.push('topology');
      return {
        ownershipFingerprint: 'a'.repeat(64),
        manifestDigest: 'b'.repeat(64),
      };
    });
    ensureInitialTenantRegionShardConfigMock.mockImplementation(async () => {
      events.push('region');
      return { created: true, config: {} };
    });
    deployAllMock.mockImplementation(async (_options, components) => {
      events.push('workers');
      const results = components.map((component, index) => ({
        component,
        workerName: `${env}-${component}`,
        version: '0.2.0',
        cloudflareVersionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        deployedAt: '2026-07-22T01:00:00.000Z',
        success: true,
      }));
      return {
        totalComponents: results.length,
        successCount: results.length,
        failedCount: 0,
        results,
      };
    });
    recordInitialBootstrapWorkerEvidenceMock.mockImplementation(async () => {
      events.push('evidence');
      return {
        workerCount: 1,
        controlDeploymentId: 'deployment-control',
        controlVersionId: 'version-control',
      };
    });
    waitForInitialBootstrapHandoffMock.mockImplementation(async (input) => {
      const checkpoint = JSON.parse(
        await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8')
      );
      expect(checkpoint.releaseUpdate?.phase).toBe('workers_deployed');
      expect(checkpoint.workers['ar-auth']?.cloudflareVersionId).toMatch(/^[a-f0-9-]{36}$/u);
      await input.refreshEvidence?.();
      events.push('acceptance');
      return { state: 'accepted', acceptedAt: 100 };
    });
    publishInitialControlPlaneRuntimeSnapshotMock.mockImplementation(async () => {
      events.push('snapshot');
      return { success: true, skipped: false };
    });
    waitForWorkerHttpReadyMock.mockImplementation(async (input) => {
      events.push(input.allowTenantRegistryBootstrapGap ? 'pre-health' : 'post-health');
      return { ready: true };
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        env,
        skipBuild: true,
        runMigrations: true,
        bootstrapToken: 'bootstrap-token-1234567890',
        tokenOwnership: 'account',
      }),
    });

    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({ success: true });
    const statusBody = await (await app.request('/deploy/status')).json();
    expect(statusBody.deploymentProgress).toMatchObject({
      operation: 'deploy',
      step: 10,
      totalSteps: 10,
      status: 'complete',
    });
    expect(statusBody.progress).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Optional downstream grant introspection was deferred'),
      ])
    );
    expect(JSON.stringify(statusBody.progress)).not.toContain(
      'optional introspection provider unavailable'
    );
    const progressLog = await readFile(statusBody.logPath, 'utf-8');
    const detailLogPath = progressLog.match(/Detailed log: (.+)$/mu)?.[1]?.trim();
    expect(detailLogPath).toBeTruthy();
    await expect(readFile(detailLogPath!, 'utf-8')).resolves.toContain(
      'optional introspection provider unavailable'
    );
    expect(configureDownstreamIntrospectionDeploymentMock).toHaveBeenCalledOnce();
    expect(configureDownstreamIntrospectionDeploymentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBaseUrl: 'https://headless-ar-router.example-subdomain.workers.dev',
        apiBaseUrls: ['https://headless-ar-router.example-subdomain.workers.dev'],
        knownRouterReadyBaseUrls: ['https://headless-ar-router.example-subdomain.workers.dev'],
      })
    );
    expect(events).toEqual([
      'schema',
      'release',
      'inventory',
      'topology',
      'region',
      'workers',
      'pre-health',
      'evidence',
      'evidence',
      'acceptance',
      'snapshot',
      'post-health',
    ]);
    expect(applyReleaseSchemaUpdatePlanMock).toHaveBeenCalledOnce();
    expect(runMigrationsForEnvironmentMock).not.toHaveBeenCalled();
    expect(resolveMissingUiWorkerBindingTargetsMock).toHaveBeenCalledWith(expect.any(Object), {
      loginUi: false,
      adminUi: false,
    });
    expect(deployUiWorkerBindingTargetsMock).not.toHaveBeenCalled();
    expect(deployAllUiWorkersMock).not.toHaveBeenCalled();
    expect(waitForWorkerHttpReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTenantRegistryBootstrapGap: true,
        targets: [
          {
            workerName: `${env}-ar-auth`,
            url: `https://${env}-ar-auth.example-subdomain.workers.dev/api/auth/health`,
          },
        ],
      })
    );
    expect(waitForWorkerHttpReadyMock).toHaveBeenCalledTimes(2);
    expect(waitForWorkerHttpReadyMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        targets: [
          {
            workerName: `${env}-ar-auth`,
            url: `https://${env}-ar-auth.example-subdomain.workers.dev/api/auth/health`,
          },
        ],
      })
    );
    expect(waitForWorkerHttpReadyMock.mock.calls[1]?.[0]).not.toHaveProperty(
      'allowTenantRegistryBootstrapGap'
    );
    expect(ensureInitialTenantRegionShardConfigMock).toHaveBeenCalledWith({
      environmentId: env,
      tenantId: 'default',
      controlDatabaseName: 'control-id',
      configNamespaceId: 'authrim_config-id',
    });
    expect(ensureAdminUiBffMachineAccessInD1Mock).not.toHaveBeenCalled();
    expect(prepareAdminUiBffDeploymentMock).not.toHaveBeenCalled();
    expect(ensureInitialTenantInD1Mock).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(Function),
      { databaseIdentifier: 'core-id' }
    );
    expect(ensureInitialAdminRolesInD1Mock).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(ensureSetupMachineAccessInD1Mock).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(String),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(cleanupSetupMachineAccessInD1Mock).toHaveBeenCalledWith(
      env,
      expect.any(String),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(seedDefaultCanonicalCatalogMock).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(seedRuntimeProfilesMock).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(Function),
      { databaseIdentifier: 'core-id' }
    );
    expect(recordInitialBootstrapWorkerEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        controlDatabaseName: 'control-id',
        allowSecretTriggeredVersionAdvanceFor: [`${env}-ar-control`],
      })
    );
    const handoffInput = waitForInitialBootstrapHandoffMock.mock.calls[0]?.[0] as
      | {
          advanceBindings?: () => Promise<unknown>;
          refreshEvidence?: () => Promise<unknown>;
          reconcile?: () => Promise<unknown>;
          pollIntervalMs?: number;
        }
      | undefined;
    expect(handoffInput?.timeoutMs).toBe(30 * 60_000);
    expect(handoffInput?.stallTimeoutMs).toBe(5 * 60_000);
    expect(handoffInput?.pollIntervalMs).toBe(2_000);
    expect(handoffInput?.advanceBindings).toEqual(expect.any(Function));
    expect(handoffInput?.refreshEvidence).toEqual(expect.any(Function));
    expect(handoffInput?.reconcile).toEqual(expect.any(Function));
    await handoffInput?.advanceBindings?.();
    await handoffInput?.refreshEvidence?.();
    await handoffInput?.reconcile?.();
    expect(requestInitialBootstrapAccelerationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        activeSlot: 'A',
        activeKeyId: 'smoke-test',
      })
    );
    expect(reconcileInitialBootstrapHandoffAsOperatorMock).toHaveBeenCalledWith({
      controlDatabaseId: 'control-id',
      environmentId: 'headless',
      executeWorkerBindings: false,
    });

    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.productVersion).toBe('0.2.0');
    expect(lock.releaseUpdate?.phase).toBe('verified');
    expect(lock.workers['ar-login-ui']).toBeUndefined();
    expect(lock.workers['ar-admin-ui']).toBeUndefined();
  });

  it('resumes initial Web deployment from a staged pre-authority generation without token input', async () => {
    const env = 'headless';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = true;
    config.cloudflare.accountId = TEST_ACCOUNT_ID;
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const manifest = JSON.parse(
      await readFile(join(tempDir!, 'migrations', 'releases', '0.2.0.json'), 'utf-8')
    );
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum: calculateReleaseManifestChecksum(manifest),
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await stageRecoverableControlBootstrap(env);
    queryD1RowsMock.mockImplementation(async (_databaseName, sql: string) => {
      if (!sql.includes('provisioning_token_management')) return [];
      return controlTokenBootstrapCompleted
        ? [readyControlProvisioningAuthorityRow(env)]
        : [tokenlessControlProvisioningAuthorityRow(env)];
    });
    deployAllMock.mockImplementation(async (_options, components) => {
      const results = components.map((component, index) => ({
        component,
        workerName: `${env}-${component}`,
        version: '0.2.0',
        cloudflareVersionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        deployedAt: '2026-08-31T00:01:00.000Z',
        success: true,
      }));
      return {
        totalComponents: results.length,
        successCount: results.length,
        failedCount: 0,
        results,
      };
    });
    getWorkerDeploymentsMock.mockImplementation(async (workerName: string) => {
      const component = workerName.slice(`${env}-`.length);
      const componentIndex = WORKER_COMPONENTS.indexOf(
        component as (typeof WORKER_COMPONENTS)[number]
      );
      return {
        name: workerName,
        exists: true,
        lastDeployedAt: '2026-08-31T00:01:00.000Z',
        author: 'test@example.com',
        versionId:
          controlTokenBootstrapCompleted && component === 'ar-control'
            ? '00000000-0000-4000-8000-000000000099'
            : `00000000-0000-4000-8000-${String(componentIndex + 1).padStart(12, '0')}`,
      };
    });
    resolveMissingUiWorkerBindingTargetsMock.mockResolvedValue({
      loginUi: false,
      adminUi: false,
    });

    const session = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': session,
      },
      body: JSON.stringify({ env, skipBuild: true, runMigrations: true }),
    });
    const responseBody = await response.json();

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({ success: true });
    expect(completeControlTokenBootstrapMock).toHaveBeenCalledOnce();
    const bootstrapCall = completeControlTokenBootstrapMock.mock.calls[0]?.[0];
    expect(bootstrapCall).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      environment: env,
      ownership: 'account',
    });
    expect(bootstrapCall).not.toHaveProperty('bootstrapToken');
  });

  it('returns the concrete bootstrap failure in the initial deployment response', async () => {
    const env = 'headless';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    await rm(join(tempDir!, 'packages'), { recursive: true, force: true });
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = true;
    config.cloudflare.accountId = 'account-id';
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    resolveMissingUiWorkerBindingTargetsMock.mockResolvedValue({
      loginUi: false,
      adminUi: false,
    });
    deployAllMock.mockImplementation(async (_options, components) => {
      const results = components.map((component, index) => ({
        component,
        workerName: `${env}-${component}`,
        version: '0.2.0',
        cloudflareVersionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        deployedAt: '2026-07-22T01:00:00.000Z',
        success: true,
      }));
      return {
        totalComponents: results.length,
        successCount: results.length,
        failedCount: 0,
        results,
      };
    });
    ensureInitialNotificationProviderConfigurationMock.mockRejectedValueOnce(
      new Error('notification provider configuration rejected')
    );

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        env,
        skipBuild: true,
        runMigrations: true,
        bootstrapToken: 'bootstrap-token-1234567890',
        tokenOwnership: 'account',
      }),
    });

    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      success: false,
      error:
        'Initial notification provider bootstrap failed: notification provider configuration rejected',
    });
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: 'error',
      error:
        'Initial notification provider bootstrap failed: notification provider configuration rejected',
    });
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.productVersion).toBeUndefined();
    expect(lock.releaseUpdate?.phase).toBe('workers_deployed');
  });

  it('retries temporary setup machine-access cleanup and verifies only after it succeeds', async () => {
    const env = 'headless';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    await rm(join(tempDir!, 'packages'), { recursive: true, force: true });
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = true;
    config.cloudflare.accountId = 'account-id';
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    resolveMissingUiWorkerBindingTargetsMock.mockResolvedValue({
      loginUi: false,
      adminUi: false,
    });
    deployAllMock.mockImplementation(async (_options, components) => {
      const results = components.map((component) => ({
        component,
        workerName: `${env}-${component}`,
        version: '0.2.0',
        cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
        deployedAt: '2026-07-22T01:00:00.000Z',
        success: true,
      }));
      return {
        totalComponents: results.length,
        successCount: results.length,
        failedCount: 0,
        results,
      };
    });
    cleanupSetupMachineAccessInD1Mock.mockResolvedValue({
      success: false,
      error: 'temporary principal revocation failed',
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const deployBody = JSON.stringify({
      env,
      skipBuild: true,
      runMigrations: true,
      bootstrapToken: 'bootstrap-token-1234567890',
      tokenOwnership: 'account',
    });
    const firstResponse = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: deployBody,
    });

    const firstBody = await firstResponse.json();
    expect(firstResponse.status, JSON.stringify(firstBody)).toBe(200);
    expect(firstBody).toMatchObject({
      success: false,
      error: 'Setup machine access cleanup failed; retry deployment to remove temporary access',
    });
    const blockedLock = JSON.parse(
      await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8')
    );
    expect(blockedLock.productVersion).toBeUndefined();
    expect(blockedLock.releaseUpdate?.phase).toBe('workers_deployed');
    expect(cleanupSetupMachineAccessInD1Mock).toHaveBeenCalledTimes(2);

    // Reproduce the stale local phase left by older retries even though Control has durably
    // accepted the handoff. The retry must not rerun schema application or artifact publication.
    blockedLock.releaseUpdate.phase = 'schema_applied';
    await writeFile(
      join(tempDir!, '.authrim', env, 'lock.json'),
      `${JSON.stringify(blockedLock, null, 2)}\n`
    );

    cleanupSetupMachineAccessInD1Mock.mockClear();
    cleanupSetupMachineAccessInD1Mock.mockResolvedValue({ success: true });
    applyReleaseSchemaUpdatePlanMock.mockClear();
    publishAndActivateMigrationReleaseMock.mockClear();
    reconcileWorkerCronTriggersMock.mockClear();
    registerInitialControlTopologyMock.mockClear();
    recordInitialBootstrapWorkerEvidenceMock.mockClear();
    waitForInitialBootstrapHandoffMock.mockClear();
    isInitialBootstrapHandoffAcceptedMock.mockResolvedValue(true);
    const retryResponse = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: deployBody,
    });

    const retryBody = await retryResponse.json();
    expect(retryResponse.status, JSON.stringify(retryBody)).toBe(200);
    expect(retryBody).toMatchObject({ success: true });
    expect(deployAllMock).toHaveBeenCalledOnce();
    expect(reconcileWorkerCronTriggersMock).toHaveBeenCalledOnce();
    expect(reconcileWorkerCronTriggersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        cloudflareAccountId: 'account-id',
        workerScriptOwnership: expect.objectContaining({
          assertBeforeMutation: expect.any(Function),
        }),
      }),
      expect.arrayContaining(['ar-management'])
    );
    expect(registerInitialControlTopologyMock).not.toHaveBeenCalled();
    expect(recordInitialBootstrapWorkerEvidenceMock).not.toHaveBeenCalled();
    expect(waitForInitialBootstrapHandoffMock).not.toHaveBeenCalled();
    expect(applyReleaseSchemaUpdatePlanMock).not.toHaveBeenCalled();
    expect(publishAndActivateMigrationReleaseMock).not.toHaveBeenCalled();
    expect(cleanupSetupMachineAccessInD1Mock).toHaveBeenCalledOnce();
    const verifiedLock = JSON.parse(
      await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8')
    );
    expect(verifiedLock.productVersion).toBe('0.2.0');
    expect(verifiedLock.releaseUpdate?.phase).toBe('verified');
  });

  it('accepts setup machine-access cleanup when its same-run retry succeeds', async () => {
    const env = 'headless';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    await rm(join(tempDir!, 'packages'), { recursive: true, force: true });
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.controlPlane.automaticProvisioning = true;
    config.cloudflare.accountId = 'account-id';
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    resolveMissingUiWorkerBindingTargetsMock.mockResolvedValue({
      loginUi: false,
      adminUi: false,
    });
    deployAllMock.mockImplementation(async (_options, components) => {
      const results = components.map((component) => ({
        component,
        workerName: `${env}-${component}`,
        version: '0.2.0',
        cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
        deployedAt: '2026-07-22T01:00:00.000Z',
        success: true,
      }));
      return {
        totalComponents: results.length,
        successCount: results.length,
        failedCount: 0,
        results,
      };
    });
    cleanupSetupMachineAccessInD1Mock
      .mockRejectedValueOnce(new Error('Cloudflare authentication error [code: 10000]'))
      .mockResolvedValue({ success: true });

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        env,
        skipBuild: true,
        runMigrations: true,
        bootstrapToken: 'bootstrap-token-1234567890',
        tokenOwnership: 'account',
      }),
    });

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ success: true });
    expect(cleanupSetupMachineAccessInD1Mock).toHaveBeenCalledTimes(2);
    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.productVersion).toBe('0.2.0');
    expect(lock.releaseUpdate?.phase).toBe('verified');
  });

  it('rejects a caller-selected subset before initial deployment build work', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);

    const token = generateSessionToken();
    const app = createApiRoutes();
    const cachedConfig = createDefaultConfig(env);
    cachedConfig.controlPlane.automaticProvisioning = false;
    cachedConfig.components.saml = false;
    const cached = await app.request('/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify(cachedConfig),
    });
    expect(cached.status).toBe(200);
    const diskConfig = { ...cachedConfig, components: { ...cachedConfig.components, saml: true } };
    await writeFile(
      join(tempDir!, '.authrim', env, 'config.json'),
      `${JSON.stringify(diskConfig, null, 2)}\n`
    );

    const response = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, components: ['ar-auth'] }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Initial deployment must include every enabled Worker component.',
      requiredComponents: expect.arrayContaining([
        'ar-auth',
        'ar-management',
        'ar-router',
        'ar-saml',
      ]),
    });
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: 'error',
      error: 'Initial deployment must include every enabled Worker component.',
      deploymentProgress: {
        operation: 'deploy',
        status: 'error',
      },
    });
    expect(buildApiPackagesMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('rejects every Worker-only Web path before the complete initial deployment', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    const token = generateSessionToken();
    const app = createApiRoutes();
    const requests: Array<[string, Record<string, unknown>]> = [
      ['/update/workers', { env, onlyChanged: false }],
      ['/deploy/component/ar-auth', { env, skipBuild: true }],
      [
        '/service-site/configure',
        {
          env,
          enabled: true,
          binding: 'SERVICE_SITE',
          workerName: 'customer-service-site',
          deployRouter: true,
        },
      ],
      [
        '/env/email/cloudflare/enable',
        { env, fromAddress: 'auth@example.com', fromName: 'Authrim' },
      ],
    ];

    for (const [path, body] of requests) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        requiredCommand: `authrim-setup update --env ${env}`,
      });
    }
    expect(deployAllMock).not.toHaveBeenCalled();
    expect(deployWorkerMock).not.toHaveBeenCalled();
  });

  it('deploys only Control for an automatic-provisioning cutover during initial deployment', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await saveKeysToDirectory(generateAllSecrets('initial-control-bootstrap'), {
      keysBaseDir: tempDir!,
      env,
    });

    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.controlPlane.automaticProvisioning = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const manifest = JSON.parse(
      await readFile(join(tempDir!, 'migrations', 'releases', '0.2.0.json'), 'utf-8')
    );
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const initialLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    initialLock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'schema_applied',
      manifestChecksum: calculateReleaseManifestChecksum(manifest),
      startedAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:01:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(initialLock, null, 2)}\n`);

    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          success: true,
          component: 'ar-control',
          workerName: 'test-ar-control',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
        },
      ],
    });

    const response = await createApiRoutes().request('/deploy/component/ar-control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': generateSessionToken(),
      },
      body: JSON.stringify({
        env,
        skipBuild: false,
        initialControlBootstrap: true,
      }),
    });

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      component: 'ar-control',
    });
    expect(buildApiPackagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ components: ['ar-control'] })
    );
    expect(deployAllMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        rootDir: tempDir,
        automaticProvisioning: false,
        deferInitialControlSmokeBindingRestore: true,
        deploymentStrategy: 'direct',
      }),
      ['ar-control']
    );
  });

  it('does not broaden initial Control bootstrap to another Worker', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);

    const response = await createApiRoutes().request('/deploy/component/ar-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': generateSessionToken(),
      },
      body: JSON.stringify({ env, initialControlBootstrap: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Initial Control bootstrap'),
    });
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('guards individual Web component deployment from product upgrades', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await writeFile(
      join(tempDir!, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.3.0' }, null, 2)}\n`
    );
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy/component/ar-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      requiredCommand: 'authrim-setup update --env test',
    });
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('guards Service Site redeployment before changing configuration', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await writeFile(
      join(tempDir!, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.3.0' }, null, 2)}\n`
    );
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const originalConfig = await readFile(configPath, 'utf-8');
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/service-site/configure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({
        env,
        enabled: true,
        binding: 'SERVICE_SITE',
        workerName: 'customer-service-site',
        deployRouter: true,
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      requiredCommand: 'authrim-setup update --env test',
    });
    expect(await readFile(configPath, 'utf-8')).toBe(originalConfig);
    expect(deployWorkerMock).not.toHaveBeenCalled();
  });

  it('guards Cloudflare Email redeployment before changing configuration', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await writeFile(
      join(tempDir!, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.3.0' }, null, 2)}\n`
    );
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const originalConfig = await readFile(configPath, 'utf-8');
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/env/email/cloudflare/enable', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, fromAddress: 'auth@example.com', fromName: 'Authrim' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      requiredCommand: 'authrim-setup update --env test',
    });
    expect(await readFile(configPath, 'utf-8')).toBe(originalConfig);
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('uses the CLI-equivalent Control recovery and Worker binding pacing in Web execution', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const operation = {
      operationId: 'provision-shard-1',
      environmentId: env,
      operationKind: 'provision_shard',
      status: 'blocked',
      lastErrorCode: 'control_worker_settings_request_rejected',
      currentStep: 'reconcile_worker_bindings',
    } as const;
    listPendingControlOperatorOperationsMock.mockResolvedValue([operation]);
    executeSetupControlOperatorWorkerBindingsMock.mockResolvedValue({ state: 'completed' });

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/control/pending-operations/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ environmentId: env, operationId: operation.operationId }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(retrySetupControlOperationStepMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: operation.operationId,
        stepKey: 'reconcile_worker_bindings',
      })
    );
    expect(executeSetupControlOperatorWorkerBindingsMock).toHaveBeenCalledWith({
      controlDatabaseId: 'control-id',
      operation,
      expectedAccountId: undefined,
      interTargetDelayMs: 0,
    });
  });

  it('reports post-patch smoke progress but does not execute it through Setup', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const operation = {
      operationId: 'provision-shard-smoke-1',
      environmentId: env,
      operationKind: 'provision_shard',
      status: 'waiting_retry',
      lastErrorCode: 'control_worker_smoke_failed',
      currentStep: 'smoke_bindings',
    } as const;
    listPendingControlOperatorOperationsMock.mockResolvedValue([operation]);

    const token = generateSessionToken();
    const app = createApiRoutes();
    const listResponse = await app.request('/control/pending-operations', {
      headers: { 'X-Session-Token': token },
    });
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      success: true,
      operations: [operation],
    });

    const executeResponse = await app.request('/control/pending-operations/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ environmentId: env, operationId: operation.operationId }),
    });
    expect(executeResponse.status).toBe(409);
    await expect(executeResponse.json()).resolves.toMatchObject({
      success: false,
      operation,
    });
    expect(executeSetupControlOperatorWorkerBindingsMock).not.toHaveBeenCalled();
  });

  it('blocks Web Control execution while a release mutation is incomplete', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'workers_deployed',
      manifestChecksum: 'a'.repeat(64),
      startedAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/control/pending-operations/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ environmentId: env, operationId: 'provision-shard-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'control_provision_release_update_in_progress',
    });
    expect(listPendingControlOperatorOperationsMock).not.toHaveBeenCalled();
    expect(executeSetupControlOperatorWorkerBindingsMock).not.toHaveBeenCalled();
  });

  it('blocks Web Control execution when a fixed D1 database UUID no longer matches', async () => {
    const env = 'test';
    await writeEnvironment(env);
    listD1DatabasesMock.mockImplementation(async () =>
      D1_DATABASES.map((database) => ({
        uuid:
          database.binding === 'CONTROL_DB'
            ? 'replacement-control-id'
            : {
                DB: 'core-id',
                DB_PII: 'pii-id',
                DB_ADMIN: 'admin-id',
                LOOKUP_DB: 'lookup-id',
                PLUGIN_RUNNER_DB: 'plugin-runner-id',
              }[database.binding],
        name: getD1DatabaseName(env, database.dbType),
      }))
    );

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/control/pending-operations/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ environmentId: env, operationId: 'provision-shard-1' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('cloudflare_resource_identity_mismatch:D1:CONTROL_DB'),
    });
    expect(listPendingControlOperatorOperationsMock).not.toHaveBeenCalled();
    expect(executeSetupControlOperatorWorkerBindingsMock).not.toHaveBeenCalled();
  });

  it('fails closed before Web deployment side effects when the workspace config lock is busy', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const originalConfig = await readFile(configPath, 'utf-8');
    const environmentOperationPath = join(tempDir!, '.authrim', env, 'lock.json.operation-lock');
    const cleanupOperation = {
      operationId: 'cleanup-plugin-1',
      environmentId: env,
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
    listPendingPluginControlCleanupOperationsMock.mockResolvedValue([cleanupOperation]);

    const held = await acquireDeployConfigLock({
      baseDir: tempDir!,
      env: 'other-environment',
      operation: 'test-competing-deploy',
    });
    try {
      const token = generateSessionToken();
      const app = createApiRoutes();
      const serviceSiteResponse = await app.request('/service-site/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
        body: JSON.stringify({
          env,
          enabled: true,
          binding: 'SERVICE_SITE',
          workerName: 'customer-service-site',
          deployRouter: true,
        }),
      });
      expect(serviceSiteResponse.status).toBe(409);
      await expect(serviceSiteResponse.clone().json()).resolves.toMatchObject({
        errorCode: 'setup_operation_in_progress',
      });
      await expect(readFile(configPath, 'utf-8')).resolves.toBe(originalConfig);
      await expect(readFile(environmentOperationPath, 'utf-8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const emailResponse = await app.request('/env/email/cloudflare/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
        body: JSON.stringify({ env, fromAddress: 'auth@example.com', fromName: 'Authrim' }),
      });
      expect(emailResponse.status).toBe(409);
      await expect(emailResponse.clone().json()).resolves.toMatchObject({
        errorCode: 'setup_operation_in_progress',
      });
      await expect(readFile(configPath, 'utf-8')).resolves.toBe(originalConfig);
      await expect(
        readFile(getEnvironmentPaths({ baseDir: tempDir!, env }).pendingEmailSecrets, 'utf-8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(environmentOperationPath, 'utf-8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const controlResponse = await app.request('/control/pending-operations/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': token,
          Origin: 'http://localhost',
        },
        body: JSON.stringify({ environmentId: env, operationId: cleanupOperation.operationId }),
      });
      expect(controlResponse.status).toBe(409);
      await expect(controlResponse.clone().json()).resolves.toMatchObject({
        errorCode: 'setup_operation_in_progress',
      });
      await expect(readFile(environmentOperationPath, 'utf-8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      expect(saveMasterWranglerConfigsMock).not.toHaveBeenCalled();
      expect(syncWranglerConfigsMock).not.toHaveBeenCalled();
      expect(buildApiPackagesMock).not.toHaveBeenCalled();
      expect(deployWorkerMock).not.toHaveBeenCalled();
      expect(deployAllMock).not.toHaveBeenCalled();
      expect(executeSetupPluginCleanupOperatorMock).not.toHaveBeenCalled();
      expect(refreshWorkerDeploymentArtifactsMock).not.toHaveBeenCalled();
    } finally {
      await held.release();
    }
  });

  it('orders Web environment/workspace lock acquisition and reverse release around side effects', async () => {
    const source = await readFile(new URL('../web/api.ts', import.meta.url), 'utf-8');
    const routeSlices = [
      {
        source: source.slice(
          source.indexOf("api.post('/service-site/configure'"),
          source.indexOf("api.post('/env/email/cloudflare/enable'")
        ),
        sideEffect: 'await writePrivateFileAtomically(',
        terminalEffect: 'await waitForWorkerDeploymentsReady({',
      },
      {
        source: source.slice(
          source.indexOf("api.post('/env/email/cloudflare/enable'"),
          source.indexOf("api.post('/provision'")
        ),
        sideEffect: 'await stagePendingEmailSecrets({',
        terminalEffect: 'await waitForWorkerDeploymentsReady({',
      },
      {
        source: source.slice(
          source.indexOf("api.post('/control/pending-operations/execute'"),
          source.indexOf("api.get('/environments'")
        ),
        sideEffect: 'const result =',
        terminalEffect: 'await refreshWorkerDeploymentArtifacts({',
      },
    ];

    for (const route of routeSlices) {
      const environmentAcquire = route.source.indexOf(
        'operationLock = await acquireEnvironmentOperationForEnvironment({'
      );
      const workspaceAcquire = route.source.indexOf(
        'deployConfigLock = await acquireDeployConfigLock({'
      );
      const firstSideEffect = route.source.indexOf(route.sideEffect);
      const terminalEffect = route.source.indexOf(route.terminalEffect);
      const workspaceRelease = route.source.indexOf('await deployConfigLock?.release();');
      const environmentRelease = route.source.indexOf('await operationLock?.release();');

      expect(environmentAcquire).toBeGreaterThanOrEqual(0);
      expect(workspaceAcquire).toBeGreaterThan(environmentAcquire);
      expect(firstSideEffect).toBeGreaterThan(workspaceAcquire);
      expect(terminalEffect).toBeGreaterThan(firstSideEffect);
      expect(workspaceRelease).toBeGreaterThan(terminalEffect);
      expect(environmentRelease).toBeGreaterThan(workspaceRelease);
    }
  });

  it('guards manual Web migration routes from applying a different product release', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await writeFile(
      join(tempDir!, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.3.0' }, null, 2)}\n`
    );
    const token = generateSessionToken();
    const app = createApiRoutes();
    for (const [path, body] of [
      ['/migrations/apply', { env, role: 'core' }],
      ['/migrations/run', { env }],
    ] as const) {
      const response = await app.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': token,
        },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        requiredCommand: 'authrim-setup update --env test',
      });
    }
  });

  it('persists a dedicated progress log for a manual Web migration run', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const token = generateSessionToken();
    const app = createApiRoutes();

    const response = await app.request('/migrations/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env }),
    });

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      success: true,
      logPath: expect.stringMatching(/-update\.log$/u),
    });
    await expect(readFile(responseBody.logPath, 'utf-8')).resolves.toContain(
      'Running D1 migrations for environment: test'
    );
    expect(runMigrationsForEnvironmentMock).toHaveBeenCalledWith(
      env,
      tempDir,
      expect.any(Function),
      expect.objectContaining({
        databaseIdentifiers: {
          core: 'core-id',
          pii: 'pii-id',
          admin: 'admin-id',
        },
      })
    );
  });

  it('queries migration status through the exact D1 IDs pinned by the environment lock', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const token = generateSessionToken();
    const app = createApiRoutes();

    const response = await app.request(`/migrations/status/${env}`, {
      headers: { 'X-Session-Token': token },
    });

    expect(response.status).toBe(200);
    expect(getD1MigrationStatusForEnvironmentMock).toHaveBeenCalledWith(
      env,
      tempDir,
      undefined,
      expect.objectContaining({
        databaseIdentifiers: {
          core: 'core-id',
          pii: 'pii-id',
          admin: 'admin-id',
        },
      })
    );
  });

  it('does not query migration status from a same-name replacement D1 database', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const inventory = await listD1DatabasesMock();
    listD1DatabasesMock.mockResolvedValue(
      inventory.map((database: { uuid: string; name: string }) =>
        database.uuid === 'core-id' ? { ...database, uuid: 'replacement-core-id' } : database
      )
    );
    const token = generateSessionToken();
    const app = createApiRoutes();

    const response = await app.request(`/migrations/status/${env}`, {
      headers: { 'X-Session-Token': token },
    });

    expect(response.status).toBe(500);
    expect(getD1MigrationStatusForEnvironmentMock).not.toHaveBeenCalled();
  });

  it('does not migrate a same-name replacement D1 database', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const inventory = await listD1DatabasesMock();
    listD1DatabasesMock.mockResolvedValue(
      inventory.map((database: { uuid: string; name: string }) =>
        database.uuid === 'core-id' ? { ...database, uuid: 'replacement-core-id' } : database
      )
    );
    const token = generateSessionToken();
    const app = createApiRoutes();

    const response = await app.request('/migrations/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env }),
    });

    expect(response.status).toBe(500);
    expect(runMigrationsForEnvironmentMock).not.toHaveBeenCalled();
  });

  it('configures Service Site fallback and deploys ar-router', async () => {
    const env = 'test';
    await writeEnvironment(env);
    deployWorkerMock.mockImplementationOnce(async () => {
      const lockPath = join(tempDir!, '.authrim', env, 'lock.json');
      const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
      lock.workerScriptOwnership = {
        'ar-router': {
          name: 'test-ar-router',
          pendingCloudflareVersionId: '00000000-0000-4000-8003-000000000001',
          state: 'pending_tag',
          updatedAt: '2026-06-18T00:00:00.000Z',
        },
        'ar-auth': {
          name: 'test-ar-auth',
          cloudflareScriptTag: 'unrelated-auth-tag',
          state: 'provisional',
          updatedAt: '2026-06-18T00:00:00.000Z',
        },
      };
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      return {
        success: true,
        workerName: 'test-ar-router',
        version: '0.3.0',
        deployedAt: '2026-06-18T00:00:00.000Z',
        cloudflareVersionId: '00000000-0000-4000-8003-000000000001',
        cloudflareScriptTag: 'immutable-worker-tag',
      };
    });
    syncWranglerConfigsMock.mockResolvedValue({
      success: true,
      errors: [],
      synced: ['ar-router'],
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/service-site/configure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({
        env,
        enabled: true,
        binding: 'SERVICE_SITE',
        workerName: 'customer-service-site',
      }),
    });
    const body = (await response.json()) as {
      success: boolean;
      serviceSite: { enabled: boolean; binding: string; workerName: string };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.serviceSite).toEqual({
      enabled: true,
      binding: 'SERVICE_SITE',
      workerName: 'customer-service-site',
      fallbackMode: 'worker_service_binding',
    });
    expect(saveMasterWranglerConfigsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceSite: expect.objectContaining({
          enabled: true,
          binding: 'SERVICE_SITE',
          workerName: 'customer-service-site',
        }),
      }),
      expect.any(Object),
      expect.objectContaining({ components: ['ar-router'] })
    );
    expect(syncWranglerConfigsMock).toHaveBeenCalledWith(
      expect.objectContaining({ components: ['ar-router'] })
    );
    expect(buildApiPackagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ components: ['ar-router'] })
    );
    expect(deployWorkerMock).toHaveBeenCalledWith(
      'ar-router',
      expect.objectContaining({
        env,
        dryRun: false,
        deployConfigLockProof: expect.objectContaining({ assertOwned: expect.any(Function) }),
      })
    );

    const config = JSON.parse(
      await readFile(join(tempDir!, '.authrim', env, 'config.json'), 'utf-8')
    );
    expect(config.serviceSite).toEqual({
      enabled: true,
      binding: 'SERVICE_SITE',
      workerName: 'customer-service-site',
      fallbackMode: 'worker_service_binding',
    });

    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.workers['ar-router']).toEqual(
      expect.objectContaining({
        name: 'test-ar-router',
        version: '0.3.0',
        cloudflareVersionId: '00000000-0000-4000-8003-000000000001',
        cloudflareScriptTag: 'immutable-worker-tag',
      })
    );
    expect(lock.workerScriptOwnership?.['ar-router']).toBeUndefined();
    expect(lock.workerScriptOwnership?.['ar-auth']).toEqual(
      expect.objectContaining({ cloudflareScriptTag: 'unrelated-auth-tag' })
    );
  });

  it('rejects enabling Service Site fallback without a worker name', async () => {
    const env = 'test';
    await writeEnvironment(env);

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/service-site/configure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({
        env,
        enabled: true,
        binding: 'SERVICE_SITE',
      }),
    });
    const body = (await response.json()) as { success: boolean; error: string };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Worker name is required');
    expect(deployWorkerMock).not.toHaveBeenCalled();
  });

  it('requires a session token before configuring Service Site fallback', async () => {
    const env = 'test';
    await writeEnvironment(env);

    const app = createApiRoutes();
    const response = await app.request('/service-site/configure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        env,
        enabled: false,
        binding: 'SERVICE_SITE',
      }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toBe('Invalid or missing session token');
    expect(deployWorkerMock).not.toHaveBeenCalled();
  });

  it('does not run downstream introspection setup during bulk worker updates', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-userinfo', '0.1.0', '0.2.0');

    deployAllMock.mockImplementation(async (options) => {
      options.onProgress('Deploying ar-auth...');
      options.onProgress('Deploying ar-userinfo...');
      return {
        totalComponents: 2,
        successCount: 2,
        failedCount: 0,
        results: [
          {
            component: 'ar-auth',
            workerName: 'test-ar-auth',
            version: '0.2.0',
            deployedAt: '2026-06-18T00:00:00.000Z',
            success: true,
          },
          {
            component: 'ar-userinfo',
            workerName: 'test-ar-userinfo',
            version: '0.2.0',
            deployedAt: '2026-06-18T00:00:00.000Z',
            success: true,
          },
        ],
      };
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true }),
    });

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(configureDownstreamIntrospectionDeploymentMock).not.toHaveBeenCalled();
  });

  it('restores and advances the exact Control token generation across bulk update retries', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-auth', '0.2.0', '0.2.0');
    await addVersionedWorkerPackage(env, 'ar-router', '0.3.0', '0.3.0');
    await addVersionedWorkerPackage(env, 'ar-control', '0.1.0', '0.2.0');
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.controlPlane.automaticProvisioning = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const generationCheckpoint = { checkpoint: 'bulk-control-generation' };
    checkpointReadyControlTokenGenerationForRedeployMock.mockResolvedValue(generationCheckpoint);
    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          component: 'ar-control',
          workerName: 'test-ar-control',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          cloudflareVersionId: '00000000-0000-4000-8005-000000000001',
          cloudflareScriptTag: 'immutable-control-update-tag',
          success: true,
        },
      ],
    });
    waitForWorkerDeploymentsReadyMock
      .mockResolvedValueOnce({ ready: false, error: 'deployment visibility timeout' })
      .mockResolvedValue({ ready: true });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const request = () =>
      app.request('/update/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
        body: JSON.stringify({ env, onlyChanged: true, includeUiWorkers: false }),
      });

    expect((await request()).status).toBe(500);
    expect(commitReadyControlTokenGenerationRedeployMock).not.toHaveBeenCalled();

    const retryResponse = await request();
    expect(retryResponse.status, JSON.stringify(await retryResponse.clone().json())).toBe(200);
    expect(checkpointReadyControlTokenGenerationForRedeployMock).toHaveBeenCalledTimes(2);
    expect(checkpointReadyControlTokenGenerationForRedeployMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId: env,
        rootDir: tempDir,
        lock: expect.objectContaining({ env }),
      })
    );
    expect(commitReadyControlTokenGenerationRedeployMock).toHaveBeenCalledOnce();
    expect(commitReadyControlTokenGenerationRedeployMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        checkpoint: generationCheckpoint,
        deployedVersionId: '00000000-0000-4000-8005-000000000001',
      })
    );
  });

  it('advances the exact Control token generation after a verified single-component deploy', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-control', '0.1.0', '0.2.0');
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.controlPlane.automaticProvisioning = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const generationCheckpoint = { checkpoint: 'single-control-generation' };
    checkpointReadyControlTokenGenerationForRedeployMock.mockResolvedValue(generationCheckpoint);
    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          component: 'ar-control',
          workerName: 'test-ar-control',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          cloudflareVersionId: '00000000-0000-4000-8006-000000000001',
          cloudflareScriptTag: 'immutable-control-component-tag',
          success: true,
        },
      ],
    });

    const response = await createApiRoutes().request('/deploy/component/ar-control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': generateSessionToken(),
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(checkpointReadyControlTokenGenerationForRedeployMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        rootDir: tempDir,
        lock: expect.objectContaining({ env }),
      })
    );
    expect(commitReadyControlTokenGenerationRedeployMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        checkpoint: generationCheckpoint,
        deployedVersionId: '00000000-0000-4000-8006-000000000001',
      })
    );
  });

  it('pre-deploys UI workers before router updates by default', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-router', '0.1.0', '0.2.0');

    deployAllMock.mockResolvedValue({
      totalComponents: 2,
      successCount: 2,
      failedCount: 0,
      results: [
        {
          component: 'ar-auth',
          workerName: 'test-ar-auth',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          success: true,
        },
        {
          component: 'ar-router',
          workerName: 'test-ar-router',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          success: true,
        },
      ],
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(deployUiWorkerBindingTargetsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        rootDir: tempDir,
        deployConfigLockProof: expect.objectContaining({ assertOwned: expect.any(Function) }),
      }),
      { loginUi: true, adminUi: true }
    );
  });

  it('retains an actionable error when a bulk Worker update partially fails', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-router', '0.1.0', '0.2.0');
    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 0,
      failedCount: 1,
      results: [
        {
          component: 'ar-router',
          workerName: 'test-ar-router',
          version: '0.2.0',
          success: false,
          error: 'Cloudflare deployment rejected',
        },
      ],
    });
    const token = generateSessionToken();
    const app = createApiRoutes();

    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Worker update failed for 1 of 1 component(s).',
    });
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: 'error',
      error: 'Worker update failed for 1 of 1 component(s).',
      deploymentProgress: null,
    });
  });

  it('does not overwrite existing UI workers with placeholder env during router updates', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-router', '0.1.0', '0.2.0');
    await addVersionedWorkerPackage(env, 'ar-login-ui', '0.1.0', '0.1.0');
    await addVersionedWorkerPackage(env, 'ar-admin-ui', '0.1.0', '0.1.0');
    resolveMissingUiWorkerBindingTargetsMock.mockResolvedValue({
      loginUi: false,
      adminUi: false,
    });

    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          component: 'ar-router',
          workerName: 'test-ar-router',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          success: true,
        },
      ],
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(deployUiWorkerBindingTargetsMock).not.toHaveBeenCalled();
  });

  it('passes supplemental API worker secrets into bulk worker updates', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await saveKeysToDirectory(generateAllSecrets('test-key'), { keysBaseDir: tempDir!, env });

    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          component: 'ar-auth',
          workerName: 'test-ar-auth',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          success: true,
        },
      ],
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(loadDeploySecretsFromKeysMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['ar-auth'])
    );
    expect(saveMasterWranglerConfigsMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.not.objectContaining({ includeDurableObjectMigrations: false })
    );
    expect(resolveExistingWorkerComponentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ env, rootDir: tempDir }),
      expect.any(Array)
    );
    expect(deployAllMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        rootDir: tempDir,
        deploymentStrategy: 'auto',
        deployConfigLockProof: expect.objectContaining({ assertOwned: expect.any(Function) }),
        existingComponents: expect.arrayContaining(['ar-auth']),
        secrets: expect.objectContaining({
          FLOW_RUNTIME_HMAC_SECRET: 'flow-runtime-secret',
          PLUGIN_ENCRYPTION_KEY: 'plugin-encryption-key',
        }),
      }),
      expect.arrayContaining(['ar-auth'])
    );
  });

  it('passes supplemental API worker secrets into single worker deploys', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await saveKeysToDirectory(generateAllSecrets('test-key'), { keysBaseDir: tempDir!, env });

    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          success: true,
          component: 'ar-auth',
          workerName: 'test-ar-auth',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
        },
      ],
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy/component/ar-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      success: true,
      component: 'ar-auth',
      logPath: expect.stringMatching(/-update\.log$/u),
    });
    await expect(readFile(responseBody.logPath, 'utf-8')).resolves.toContain(
      'Deploying component: ar-auth'
    );
    expect(loadDeploySecretsFromKeysMock).toHaveBeenCalledWith(expect.any(String), ['ar-auth']);
    expect(deployAllMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        rootDir: tempDir,
        deploymentStrategy: 'auto',
        deployConfigLockProof: expect.objectContaining({ assertOwned: expect.any(Function) }),
        existingComponents: expect.arrayContaining(['ar-auth']),
        secrets: expect.objectContaining({
          FLOW_RUNTIME_HMAC_SECRET: 'flow-runtime-secret',
          PLUGIN_ENCRYPTION_KEY: 'plugin-encryption-key',
        }),
      }),
      ['ar-auth']
    );
  });

  it('uses ephemeral Setup machine access for a Web ar-userinfo retry', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await saveKeysToDirectory(generateAllSecrets('userinfo-retry-key'), {
      keysBaseDir: tempDir!,
      env,
    });

    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          success: true,
          component: 'ar-userinfo',
          workerName: 'test-ar-userinfo',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000011',
          cloudflareScriptTag: 'immutable-ar-userinfo-tag',
        },
      ],
    });
    const events: string[] = [];
    ensureSetupMachineAccessInD1Mock.mockImplementationOnce(async () => {
      events.push('ensure');
      return { success: true };
    });
    configureDownstreamIntrospectionDeploymentMock.mockImplementationOnce(async () => {
      events.push('configure');
      return { success: true, skipped: true };
    });
    cleanupSetupMachineAccessInD1Mock.mockImplementationOnce(async () => {
      events.push('cleanup');
      return { success: true };
    });

    const response = await createApiRoutes().request('/deploy/component/ar-userinfo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': generateSessionToken(),
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(events).toEqual(['ensure', 'configure', 'cleanup']);
    expect(ensureSetupMachineAccessInD1Mock).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(String),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(cleanupSetupMachineAccessInD1Mock).toHaveBeenCalledWith(
      env,
      expect.any(String),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
  });

  it('treats user-managed wildcard DNS as a waiting action instead of a deploy error', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.tenant.multiTenant = true;
    config.tenant.baseDomain = 'test.example.com';
    config.urls = {
      api: {
        custom: 'https://test.example.com',
        auto: 'https://test-ar-router.example.workers.dev',
        zoneId: 'zone-id',
        customDomainBinding: true,
      },
      loginUi: {
        custom: null,
        auto: 'https://test-ar-login-ui.example.workers.dev',
        sameAsApi: false,
      },
      adminUi: {
        custom: null,
        auto: 'https://test-ar-admin-ui.example.workers.dev',
        sameAsApi: false,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    ensureWildcardDnsForMultiTenantMock.mockRejectedValue(
      new Error('Token lacks dns:edit permission to create wildcard DNS record')
    );

    const token = generateSessionToken();
    const app = createApiRoutes();
    const resetResponse = await app.request('/reset', {
      method: 'POST',
      headers: { 'X-Session-Token': token },
    });
    expect(resetResponse.status).toBe(200);
    const response = await app.request('/deploy/component/ar-router', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      waitingForUser: true,
      manualAction: {
        kind: 'wildcard-dns',
        baseDomain: 'test.example.com',
      },
    });
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: 'waiting',
      error: null,
      progress: expect.arrayContaining(['⚠️ Waiting for the user to configure wildcard DNS.']),
    });
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('rejects a same-name replacement DB_ADMIN before single Login UI bootstrap', async () => {
    const env = 'test';
    await writeEnvironment(env);
    const databases = (await listD1DatabasesMock()) as Array<{ uuid: string; name: string }>;
    listD1DatabasesMock.mockResolvedValue(
      databases.map((database) =>
        database.name === 'test-authrim-admin-db'
          ? { ...database, uuid: 'replacement-admin-id' }
          : database
      )
    );

    const token = generateSessionToken();
    const response = await createApiRoutes().request('/deploy/component/ar-login-ui', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('cloudflare_resource_identity_mismatch'),
    });
    expect(ensureInitialTenantInD1Mock).not.toHaveBeenCalled();
    expect(ensureSetupMachineAccessInD1Mock).not.toHaveBeenCalled();
    expect(cleanupSetupMachineAccessInD1Mock).not.toHaveBeenCalled();
    expect(prepareAdminUiBffDeploymentMock).not.toHaveBeenCalled();
  });

  it('rejects a concurrent Web mutation instead of queueing a duplicate deployment', async () => {
    const env = 'test';
    await writeEnvironment(env);
    let releaseDeployment!: () => void;
    let markDeploymentStarted!: () => void;
    const deploymentGate = new Promise<void>((resolve) => {
      releaseDeployment = resolve;
    });
    const deploymentStarted = new Promise<void>((resolve) => {
      markDeploymentStarted = resolve;
    });
    deployAllMock.mockImplementationOnce(async () => {
      markDeploymentStarted();
      await deploymentGate;
      return {
        totalComponents: 1,
        successCount: 1,
        failedCount: 0,
        results: [
          {
            success: true,
            component: 'ar-auth',
            workerName: 'test-ar-auth',
            version: '0.2.0',
            deployedAt: '2026-06-18T00:00:00.000Z',
          },
        ],
      };
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const request = () =>
      app.request('/deploy/component/ar-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': token,
        },
        body: JSON.stringify({ env, skipBuild: true }),
      });

    const firstRequest = request();
    await deploymentStarted;
    const duplicateResponse = await request();
    const competingControlResponse = await app.request('/control/pending-operations/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
      body: JSON.stringify({ environmentId: env, operationId: 'operation-1' }),
    });
    releaseDeployment();
    const firstResponse = await firstRequest;

    expect(duplicateResponse.status).toBe(409);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'setup_operation_in_progress',
    });
    expect(competingControlResponse.status).toBe(409);
    await expect(competingControlResponse.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'setup_operation_in_progress',
    });
    expect(firstResponse.status).toBe(200);
    expect(deployAllMock).toHaveBeenCalledOnce();
  });

  it('returns failure when an individual Worker deployment never becomes visible', async () => {
    const env = 'test';
    await writeEnvironment(env);
    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          success: true,
          component: 'ar-auth',
          workerName: 'test-ar-auth',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
        },
      ],
    });
    waitForWorkerDeploymentsReadyMock.mockResolvedValue({
      ready: false,
      error: 'deployment visibility timeout',
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy/component/ar-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('deployment visibility timeout'),
    });
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('deployment visibility timeout'),
      deploymentProgress: null,
    });
    const failedCheckpoint = JSON.parse(
      await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8')
    );
    expect(failedCheckpoint.workers['ar-auth']).toMatchObject({
      version: '0.1.0',
      cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
    });

    waitForWorkerDeploymentsReadyMock.mockResolvedValue({ ready: true });
    const retryResponse = await app.request('/deploy/component/ar-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, skipBuild: true }),
    });
    expect(retryResponse.status).toBe(200);
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: 'complete',
      error: null,
      deploymentProgress: null,
    });
    expect(deployAllMock).toHaveBeenCalledTimes(2);
    const successfulCheckpoint = JSON.parse(
      await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8')
    );
    expect(successfulCheckpoint.workers['ar-auth']).toMatchObject({
      version: '0.2.0',
      cloudflareVersionId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
  });

  it('does not checkpoint an unverified bulk Worker deployment and redeploys it on retry', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-router', '0.3.0', '0.3.0');
    deployAllMock.mockResolvedValue({
      totalComponents: 1,
      successCount: 1,
      failedCount: 0,
      results: [
        {
          success: true,
          component: 'ar-auth',
          workerName: 'test-ar-auth',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
        },
      ],
    });
    waitForWorkerDeploymentsReadyMock.mockResolvedValueOnce({
      ready: false,
      error: 'deployment visibility timeout',
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const request = () =>
      app.request('/update/workers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': token,
        },
        body: JSON.stringify({ env, onlyChanged: true, includeUiWorkers: false }),
      });

    const firstResponse = await request();
    expect(firstResponse.status).toBe(500);
    await expect(firstResponse.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('deployment visibility timeout'),
    });
    const failedCheckpoint = JSON.parse(
      await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8')
    );
    expect(failedCheckpoint.workers['ar-auth']).toMatchObject({
      version: '0.1.0',
      cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
    });

    waitForWorkerDeploymentsReadyMock.mockResolvedValue({ ready: true });
    const retryResponse = await request();
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toMatchObject({ success: true });
    expect(deployAllMock).toHaveBeenCalledTimes(2);
    const successfulCheckpoint = JSON.parse(
      await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8')
    );
    expect(successfulCheckpoint.workers['ar-auth']).toMatchObject({
      version: '0.2.0',
      cloudflareVersionId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
  });

  it('fails a bulk Worker no-op when locked deployments are not healthy', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-auth', '0.2.0', '0.2.0');
    await addVersionedWorkerPackage(env, 'ar-router', '0.3.0', '0.3.0');
    waitForWorkerDeploymentsReadyMock.mockResolvedValue({
      ready: false,
      error: 'locked deployment disappeared',
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true, includeUiWorkers: false }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('locked deployment disappeared'),
    });
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('skips UI worker pre-deploys when bulk update excludes Admin UI and Login UI', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await addVersionedWorkerPackage(env, 'ar-router', '0.1.0', '0.2.0');

    deployAllMock.mockResolvedValue({
      totalComponents: 2,
      successCount: 2,
      failedCount: 0,
      results: [
        {
          component: 'ar-auth',
          workerName: 'test-ar-auth',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          success: true,
        },
        {
          component: 'ar-router',
          workerName: 'test-ar-router',
          version: '0.2.0',
          deployedAt: '2026-06-18T00:00:00.000Z',
          success: true,
        },
      ],
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/update/workers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ env, onlyChanged: true, includeUiWorkers: false }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(deployUiWorkerBindingTargetsMock).not.toHaveBeenCalled();
  });
});
