import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { CORE_WORKER_COMPONENTS } from '../core/naming.js';
import { stagePendingControlBootstrap } from '../core/pending-control-bootstrap.js';
import { acquireEnvironmentOperationLock, type AuthrimLock } from '../core/lock.js';
import {
  calculateReleaseManifestChecksum,
  calculateReleaseMigrationChecksum,
} from '../core/release-migrations.js';

type MockSpinner = {
  text: string;
  isSpinning: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  succeed: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  buildApiPackages: vi.fn(),
  loadDeploySecretsFromKeys: vi.fn(),
  deployAll: vi.fn(),
  reconcileWorkerCronTriggers: vi.fn(),
  deployAllUiWorkers: vi.fn(),
  deployUiWorkerBindingTargets: vi.fn(),
  resolveExistingWorkerComponents: vi.fn(),
  resolveMissingUiWorkerBindingTargets: vi.fn(),
  isWranglerInstalled: vi.fn(),
  checkAuth: vi.fn(),
  detectCloudflareTokenOwnership: vi.fn(),
  validateDirectControlTokensWithEvidence: vi.fn(),
  readActiveControlSecretGeneration: vi.fn(),
  writeControlProvisioningAuthority: vi.fn(),
  completeControlTokenBootstrap: vi.fn(),
  getWorkersSubdomain: vi.fn(),
  runMigrationsForEnvironment: vi.fn(),
  applyReleaseSchemaUpdatePlan: vi.fn(),
  ensureInitialTenantInD1: vi.fn(),
  ensureInitialAdminRolesInD1: vi.fn(),
  ensureSetupMachineAccessInD1: vi.fn(),
  ensureAdminUiBffMachineAccessInD1: vi.fn(),
  cleanupSetupMachineAccessInD1: vi.fn(),
  seedDefaultCanonicalCatalog: vi.fn(),
  seedRuntimeProfiles: vi.fn(),
  ensureWildcardDnsForMultiTenant: vi.fn(),
  listD1Databases: vi.fn(),
  listKVNamespaces: vi.fn(),
  listQueues: vi.fn(),
  listR2Buckets: vi.fn(),
  listWorkers: vi.fn(),
  getWorkerDeployments: vi.fn(),
  assertR2BucketOwnershipForUse: vi.fn(),
  queryD1Rows: vi.fn(),
  saveMasterWranglerConfigs: vi.fn(),
  compileControlWorkerInventoryFromArtifacts: vi.fn(),
  registerControlWorkerInventory: vi.fn(),
  registerInitialControlTopology: vi.fn(),
  isInitialBootstrapHandoffAccepted: vi.fn(),
  advanceInitialBootstrapWorkerBindingsAsOperator: vi.fn(),
  reconcileInitialBootstrapHandoffAsOperator: vi.fn(),
  recordInitialBootstrapWorkerEvidence: vi.fn(),
  requestInitialBootstrapAcceleration: vi.fn(),
  waitForInitialBootstrapHandoff: vi.fn(),
  initializeControlKeyState: vi.fn(),
  reconcileLocalControlKeyFiles: vi.fn(),
  loadControlGeneratedKeyState: vi.fn(),
  loadControlStagedSigningKeys: vi.fn(),
  projectControlGeneratedKeyState: vi.fn(),
  discoverExternalCapabilities: vi.fn(),
  registerExternalCapabilities: vi.fn(),
  publishAndActivateMigrationRelease: vi.fn(),
  checkWranglerStatus: vi.fn(),
  syncWranglerConfigs: vi.fn(),
  waitForRouterWorkerReady: vi.fn(),
  waitForTenantRoutingReady: vi.fn(),
  waitForWorkerDeploymentsReady: vi.fn(),
  waitForWorkerHttpReady: vi.fn(),
  buildWorkerHttpReadinessTargets: vi.fn(),
  prepareManagedWorkerScriptOwnership: vi.fn(),
  assertLocalDeploymentCapacity: vi.fn(),
  ensureInitialControlPlaneResources: vi.fn(),
  ensureInitialTenantRegionShardConfig: vi.fn(),
  publishInitialControlPlaneRuntimeSnapshot: vi.fn(),
  ensureInitialNotificationProviderConfiguration: vi.fn(),
  completeInitialSetup: vi.fn(),
  prepareAdminUiBffDeployment: vi.fn(),
  printCliCapabilitySummary: vi.fn(),
  configureDownstreamIntrospectionDeployment: vi.fn(),
  oraSpinners: [] as MockSpinner[],
}));

vi.mock('ora', () => ({
  default: vi.fn(() => {
    const spinner = {
      text: '',
      isSpinning: false,
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      warn: vi.fn(),
    };
    spinner.start.mockImplementation(() => {
      spinner.isSpinning = true;
      return spinner;
    });
    spinner.stop.mockImplementation(() => {
      spinner.isSpinning = false;
      return spinner;
    });
    for (const settle of [spinner.succeed, spinner.fail, spinner.warn]) {
      settle.mockImplementation(() => {
        spinner.isSpinning = false;
        return spinner;
      });
    }
    mocks.oraSpinners.push(spinner);
    return spinner;
  }),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: mocks.confirm,
  select: vi.fn(async () => 'overwrite'),
}));

vi.mock('../core/deploy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/deploy.js')>();
  return {
    ...actual,
    buildApiPackages: mocks.buildApiPackages,
    deployAll: mocks.deployAll,
    reconcileWorkerCronTriggers: mocks.reconcileWorkerCronTriggers,
    deployAllUiWorkers: mocks.deployAllUiWorkers,
    deployUiWorkerBindingTargets: mocks.deployUiWorkerBindingTargets,
    loadDeploySecretsFromKeys: mocks.loadDeploySecretsFromKeys,
    resolveExistingWorkerComponents: mocks.resolveExistingWorkerComponents,
    resolveMissingUiWorkerBindingTargets: mocks.resolveMissingUiWorkerBindingTargets,
  };
});

vi.mock('../core/local-deployment-capacity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/local-deployment-capacity.js')>();
  return {
    ...actual,
    assertLocalDeploymentCapacity: mocks.assertLocalDeploymentCapacity,
  };
});

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    isWranglerInstalled: mocks.isWranglerInstalled,
    checkAuth: mocks.checkAuth,
    getWorkersSubdomain: mocks.getWorkersSubdomain,
    runMigrationsForEnvironment: mocks.runMigrationsForEnvironment,
    ensureInitialTenantInD1: mocks.ensureInitialTenantInD1,
    ensureInitialAdminRolesInD1: mocks.ensureInitialAdminRolesInD1,
    ensureSetupMachineAccessInD1: mocks.ensureSetupMachineAccessInD1,
    ensureAdminUiBffMachineAccessInD1: mocks.ensureAdminUiBffMachineAccessInD1,
    cleanupSetupMachineAccessInD1: mocks.cleanupSetupMachineAccessInD1,
    seedDefaultCanonicalCatalog: mocks.seedDefaultCanonicalCatalog,
    seedRuntimeProfiles: mocks.seedRuntimeProfiles,
    ensureWildcardDnsForMultiTenant: mocks.ensureWildcardDnsForMultiTenant,
    listD1Databases: mocks.listD1Databases,
    listKVNamespaces: mocks.listKVNamespaces,
    listQueues: mocks.listQueues,
    listR2Buckets: mocks.listR2Buckets,
    listWorkers: mocks.listWorkers,
    getWorkerDeployments: mocks.getWorkerDeployments,
    assertR2BucketOwnershipForUse: mocks.assertR2BucketOwnershipForUse,
    queryD1Rows: mocks.queryD1Rows,
  };
});

vi.mock('../core/cloudflare-control-token-bootstrap.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/cloudflare-control-token-bootstrap.js')>();
  return {
    ...actual,
    detectCloudflareTokenOwnership: mocks.detectCloudflareTokenOwnership,
    validateDirectControlTokensWithEvidence: mocks.validateDirectControlTokensWithEvidence,
    WranglerControlSecretSink: class {
      async readActiveGeneration() {
        return mocks.readActiveControlSecretGeneration();
      }

      async listNames() {
        return ['CLOUDFLARE_D1_API_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN'];
      }

      async has() {
        return true;
      }
    },
  };
});

vi.mock('../core/control-provisioning-authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/control-provisioning-authority.js')>();
  return {
    ...actual,
    writeControlProvisioningAuthority: mocks.writeControlProvisioningAuthority,
  };
});

vi.mock('../core/control-token-bootstrap-orchestrator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/control-token-bootstrap-orchestrator.js')>();
  return {
    ...actual,
    completeControlTokenBootstrap: mocks.completeControlTokenBootstrap,
  };
});

vi.mock('../core/wrangler-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/wrangler-sync.js')>();
  return {
    ...actual,
    saveMasterWranglerConfigs: mocks.saveMasterWranglerConfigs,
    checkWranglerStatus: mocks.checkWranglerStatus,
    syncWranglerConfigs: mocks.syncWranglerConfigs,
  };
});

vi.mock('../core/control-worker-inventory.js', () => ({
  compileControlWorkerInventoryFromArtifacts: mocks.compileControlWorkerInventoryFromArtifacts,
  registerControlWorkerInventory: mocks.registerControlWorkerInventory,
}));

vi.mock('../core/control-bootstrap-handoff.js', () => ({
  registerInitialControlTopology: mocks.registerInitialControlTopology,
  isInitialBootstrapHandoffAccepted: mocks.isInitialBootstrapHandoffAccepted,
  advanceInitialBootstrapWorkerBindingsAsOperator:
    mocks.advanceInitialBootstrapWorkerBindingsAsOperator,
  reconcileInitialBootstrapHandoffAsOperator: mocks.reconcileInitialBootstrapHandoffAsOperator,
  recordInitialBootstrapWorkerEvidence: mocks.recordInitialBootstrapWorkerEvidence,
  requestInitialBootstrapAcceleration: mocks.requestInitialBootstrapAcceleration,
  waitForInitialBootstrapHandoff: mocks.waitForInitialBootstrapHandoff,
}));

vi.mock('../core/control-key-state.js', () => ({
  initializeControlKeyState: mocks.initializeControlKeyState,
  reconcileLocalControlKeyFiles: mocks.reconcileLocalControlKeyFiles,
}));

vi.mock('../core/control-generated-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/control-generated-state.js')>();
  return {
    ...actual,
    loadControlGeneratedKeyState: mocks.loadControlGeneratedKeyState,
    loadControlStagedSigningKeys: mocks.loadControlStagedSigningKeys,
    projectControlGeneratedKeyState: mocks.projectControlGeneratedKeyState,
  };
});

vi.mock('../core/external-capability-registration.js', () => ({
  discoverExternalCapabilities: mocks.discoverExternalCapabilities,
  registerExternalCapabilities: mocks.registerExternalCapabilities,
}));

vi.mock('../core/migration-release-publication.js', () => ({
  publishAndActivateMigrationRelease: mocks.publishAndActivateMigrationRelease,
}));

vi.mock('../core/release-update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/release-update.js')>();
  return {
    ...actual,
    applyReleaseSchemaUpdatePlan: mocks.applyReleaseSchemaUpdatePlan,
  };
});

vi.mock('../core/worker-readiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/worker-readiness.js')>();
  return {
    ...actual,
    waitForRouterWorkerReady: mocks.waitForRouterWorkerReady,
    waitForTenantRoutingReady: mocks.waitForTenantRoutingReady,
    waitForWorkerDeploymentsReady: mocks.waitForWorkerDeploymentsReady,
    waitForWorkerHttpReady: mocks.waitForWorkerHttpReady,
    buildWorkerHttpReadinessTargets: mocks.buildWorkerHttpReadinessTargets,
  };
});

vi.mock('../core/worker-script-ownership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/worker-script-ownership.js')>();
  return {
    ...actual,
    prepareManagedWorkerScriptOwnership: mocks.prepareManagedWorkerScriptOwnership,
  };
});

vi.mock('../core/control-plane-bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/control-plane-bootstrap.js')>();
  return {
    ...actual,
    ensureInitialControlPlaneResources: mocks.ensureInitialControlPlaneResources,
    ensureInitialTenantRegionShardConfig: mocks.ensureInitialTenantRegionShardConfig,
    publishInitialControlPlaneRuntimeSnapshot: mocks.publishInitialControlPlaneRuntimeSnapshot,
  };
});

vi.mock('../core/notification-provider-bootstrap.js', () => ({
  ensureInitialNotificationProviderConfiguration:
    mocks.ensureInitialNotificationProviderConfiguration,
}));

vi.mock('../core/admin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/admin.js')>();
  return { ...actual, completeInitialSetup: mocks.completeInitialSetup };
});

vi.mock('../core/admin-ui-bff-deployment.js', () => ({
  prepareAdminUiBffDeployment: mocks.prepareAdminUiBffDeployment,
}));

vi.mock('../core/downstream-introspection-deploy.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/downstream-introspection-deploy.js')>();
  return {
    ...actual,
    configureDownstreamIntrospectionDeployment: mocks.configureDownstreamIntrospectionDeployment,
  };
});

vi.mock('../cli/capability-summary.js', () => ({
  printCliCapabilitySummary: mocks.printCliCapabilitySummary,
}));

import {
  assertExplicitLegacyInitialWorkerRecoveryState,
  buildInitialHandoffResumeSummary,
  deployCommand,
  isInitialDeploymentLock,
} from '../cli/commands/deploy.js';
import { initI18n } from '../i18n/index.js';

const originalCwd = process.cwd();
let root: string;
let controlBootstrapCompleted = false;
const TEST_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

async function writeHeadlessEnvironment(env: string, automaticProvisioning = false): Promise<void> {
  const config = createDefaultConfig(env);
  config.components.loginUi = false;
  config.components.adminUi = false;
  config.controlPlane = { automaticProvisioning };

  await mkdir(join(root, '.authrim', env), { recursive: true });
  for (const component of [...CORE_WORKER_COMPONENTS, 'ar-login-ui', 'ar-admin-ui']) {
    await mkdir(join(root, 'packages', component), { recursive: true });
    await writeFile(
      join(root, 'packages', component, 'package.json'),
      JSON.stringify({ name: `@authrim/${component}`, version: '0.2.0' })
    );
  }
  await mkdir(join(root, 'migrations'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await writeFile(join(root, 'packages', 'ar-lib-core', 'wrangler.toml'), 'name = "test"\n');
  await writeFile(
    join(root, '.authrim', env, 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`
  );
  await writeFile(
    join(root, '.authrim', env, 'lock.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        env,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
        d1: {
          DB: { id: 'core-id', name: `${env}-authrim-core-db` },
          DB_PII: { id: 'pii-id', name: `${env}-authrim-pii-db` },
          DB_ADMIN: { id: 'admin-id', name: `${env}-authrim-admin-db` },
          CONTROL_DB: { id: 'control-id', name: `${env}-authrim-control-db` },
          LOOKUP_DB: { id: 'lookup-id', name: `${env}-authrim-lookup-db` },
          PLUGIN_RUNNER_DB: {
            id: 'plugin-runner-id',
            name: `${env}-authrim-plugin-runner-db`,
          },
        },
        kv: Object.fromEntries(
          [
            'CLIENTS_CACHE',
            'INITIAL_ACCESS_TOKENS',
            'SETTINGS',
            'REBAC_CACHE',
            'USER_CACHE',
            'AUTHRIM_CONFIG',
            'TENANT_RUNTIME_REGISTRY',
            'STATE_STORE',
            'CONSENT_CACHE',
          ].map((binding) => [
            binding,
            { id: `${binding.toLowerCase()}-id`, name: `${env.toUpperCase()}-${binding}` },
          ])
        ),
        queues: {},
        r2: {
          MIGRATION_RELEASES: { name: `${env}-migration-releases` },
        },
        workers: {},
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(root, 'migrations', 'release-manifest.draft.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        productVersion: '0.2.0',
        streams: [
          { id: 'd1-core', dialect: 'sqlite', logicalRoles: ['core'], files: [] },
          { id: 'd1-pii', dialect: 'sqlite', logicalRoles: ['pii'], files: [] },
          { id: 'd1-admin', dialect: 'sqlite', logicalRoles: ['admin'], files: [] },
          { id: 'd1-control', dialect: 'sqlite', logicalRoles: ['control'], files: [] },
          { id: 'd1-lookup', dialect: 'sqlite', logicalRoles: ['lookup'], files: [] },
          {
            id: 'd1-plugin-runner',
            dialect: 'sqlite',
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

const QUEUE_BINDINGS = [
  ['AUDIT_QUEUE', 'audit-queue'],
  ['LOGGING_DELIVERY_CRITICAL_QUEUE', 'logging-delivery-critical-queue'],
  ['LOGGING_DELIVERY_QUEUE', 'logging-delivery-queue'],
  ['LOGGING_DELIVERY_BULK_QUEUE', 'logging-delivery-bulk-queue'],
] as const;

async function enableQueuesForHeadlessEnvironment(env: string): Promise<void> {
  const configPath = join(root, '.authrim', env, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8'));
  config.features.queue.enabled = true;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const lockPath = join(root, '.authrim', env, 'lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
  lock.queues = Object.fromEntries(
    QUEUE_BINDINGS.map(([binding, suffix]) => [
      binding,
      { id: `queue-${binding.toLowerCase()}-id`, name: `${env}-${suffix}` },
    ])
  );
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  mocks.listQueues.mockResolvedValue(
    QUEUE_BINDINGS.map(([binding, suffix]) => ({
      id: `queue-${binding.toLowerCase()}-id`,
      name: `${env}-${suffix}`,
    }))
  );
}

async function enableLegacyQueueSentinelsForHeadlessEnvironment(env: string): Promise<void> {
  await enableQueuesForHeadlessEnvironment(env);
  const lockPath = join(root, '.authrim', env, 'lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
  for (const queue of Object.values(lock.queues) as Array<{ id: string; name: string }>) {
    queue.id = queue.name;
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

async function prepareAppendOnlyDraftCheckpoint(env: string): Promise<{
  oldManifestChecksum: string;
  currentManifestChecksum: string;
}> {
  const migrationDirectory = join(root, 'migrations', 'control');
  const firstMigrationPath = join(migrationDirectory, '001_initial.sql');
  const appendedMigrationPath = join(migrationDirectory, '002_appended.sql');
  await mkdir(migrationDirectory, { recursive: true });
  await writeFile(firstMigrationPath, 'CREATE TABLE initial_state (id TEXT PRIMARY KEY);\n');
  await writeFile(appendedMigrationPath, 'ALTER TABLE initial_state ADD COLUMN value TEXT;\n');

  const draftPath = join(root, 'migrations', 'release-manifest.draft.json');
  const currentManifest = JSON.parse(await readFile(draftPath, 'utf-8'));
  const controlStream = currentManifest.streams.find(
    (stream: { id: string }) => stream.id === 'd1-control'
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
  oldManifest.streams.find((stream: { id: string }) => stream.id === 'd1-control').files.pop();
  const oldManifestChecksum = calculateReleaseManifestChecksum(oldManifest);
  const currentManifestChecksum = calculateReleaseManifestChecksum(currentManifest);
  const lockPath = join(root, '.authrim', env, 'lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
  const streamByBinding = new Map([
    ['DB', 'd1-core'],
    ['DB_PII', 'd1-pii'],
    ['DB_ADMIN', 'd1-admin'],
    ['CONTROL_DB', 'd1-control'],
    ['LOOKUP_DB', 'd1-lookup'],
    ['PLUGIN_RUNNER_DB', 'd1-plugin-runner'],
  ]);
  const targetIds: string[] = [];
  lock.schemaTargets = {};
  for (const [binding, streamId] of streamByBinding) {
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
      updatedAt: '2026-07-22T00:01:00.000Z',
    };
  }
  lock.releaseUpdate = {
    targetVersion: '0.2.0',
    phase: 'schema_applied',
    manifestChecksum: oldManifestChecksum,
    startedAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:01:00.000Z',
    appliedTargets: targetIds,
    manualTargets: [],
  };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return { oldManifestChecksum, currentManifestChecksum };
}

function successfulDeploymentSummary(
  env: string,
  components: readonly (typeof CORE_WORKER_COMPONENTS)[number][] = CORE_WORKER_COMPONENTS
) {
  const results = components.map((component, index) => ({
    component,
    workerName: `${env}-${component}`,
    version: '0.2.0',
    cloudflareVersionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    cloudflareScriptTag: `immutable-worker-tag-${index + 1}`,
    deployedAt: '2026-07-22T01:00:00.000Z',
    success: true,
  }));
  return {
    totalComponents: results.length,
    successCount: results.length,
    failedCount: 0,
    results,
    startedAt: '2026-07-22T01:00:00.000Z',
    completedAt: '2026-07-22T01:00:00.000Z',
    duration: 0,
  };
}

function controlProvisioningAuthorityRow(
  environment: string,
  state: 'tokenless' | 'ready'
): Record<string, unknown> {
  const ready = state === 'ready';
  return {
    environment_id: environment,
    automatic_provisioning_enabled: 1,
    provisioning_token_ownership: ready ? 'account' : 'none',
    provisioning_token_management: ready ? 'setup' : 'none',
    provisioning_capability_state: ready ? 'ready' : 'pending',
    provisioning_capability_checked_at: ready ? 101 : null,
    provisioning_bootstrap_phase: 'none',
    provisioning_bootstrap_token_ownership: 'none',
    provisioning_bootstrap_token_id: null,
    provisioning_bootstrap_token_fingerprint: null,
    provisioning_child_tokens_json: ready
      ? JSON.stringify([
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
        ])
      : null,
    provisioning_secret_generation_deployment_id: ready ? 'deployment-staged' : null,
    provisioning_secret_generation_version_id: ready
      ? '00000000-0000-4000-8000-000000000099'
      : null,
    updated_at: ready ? 101 : 100,
  };
}

async function stageRecoverableControlBootstrap(environment: string): Promise<void> {
  const bootstrapToken = 'staged-bootstrap-token-value-1234567890';
  await stagePendingControlBootstrap({
    baseDir: root,
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

describe('CLI initial deployment', () => {
  beforeEach(async () => {
    await initI18n('en');
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-cli-initial-deploy-')));
    process.chdir(root);
    vi.clearAllMocks();
    controlBootstrapCompleted = false;
    mocks.oraSpinners.length = 0;
    mocks.assertLocalDeploymentCapacity.mockResolvedValue(2 * 1024 * 1024 * 1024);
    mocks.reconcileWorkerCronTriggers.mockResolvedValue(undefined);

    mocks.isWranglerInstalled.mockResolvedValue(true);
    mocks.checkAuth.mockResolvedValue({
      isLoggedIn: true,
      email: 'test@example.com',
      accountId: '0123456789abcdef0123456789abcdef',
    });
    mocks.detectCloudflareTokenOwnership.mockResolvedValue('user');
    mocks.assertR2BucketOwnershipForUse.mockResolvedValue(undefined);
    mocks.validateDirectControlTokensWithEvidence.mockResolvedValue({
      ownership: 'user',
      childTokens: [
        {
          resourceClass: 'd1',
          tokenId: '2'.repeat(32),
          tokenName: 'operator-managed-d1',
          secretName: 'CLOUDFLARE_D1_API_TOKEN',
          tokenFingerprint: 'a'.repeat(64),
        },
        {
          resourceClass: 'workers',
          tokenId: '3'.repeat(32),
          tokenName: 'operator-managed-workers',
          secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
          tokenFingerprint: 'b'.repeat(64),
        },
      ],
    });
    mocks.readActiveControlSecretGeneration.mockResolvedValue({
      deploymentId: 'control-deployment-id',
      versionId: successfulDeploymentSummary('headless').results.find(
        (result) => result.component === 'ar-control'
      )!.cloudflareVersionId,
    });
    mocks.writeControlProvisioningAuthority.mockResolvedValue(undefined);
    mocks.completeControlTokenBootstrap.mockImplementation(async () => {
      controlBootstrapCompleted = true;
    });
    mocks.getWorkersSubdomain.mockResolvedValue('example-subdomain');
    mocks.prepareManagedWorkerScriptOwnership.mockImplementation(async ({ lock }) => ({
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
    mocks.loadDeploySecretsFromKeys.mockResolvedValue({
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-v1',
      SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
      CLOUDFLARE_D1_API_TOKEN: 'd1-token',
      CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
    });
    mocks.deployAll.mockImplementation(async (_options, components) =>
      successfulDeploymentSummary('headless', components ?? CORE_WORKER_COMPONENTS)
    );
    mocks.applyReleaseSchemaUpdatePlan.mockResolvedValue({
      success: true,
      results: [
        'd1:admin-id:d1-admin',
        'd1:control-id:d1-control',
        'd1:core-id:d1-core',
        'd1:lookup-id:d1-lookup',
        'd1:pii-id:d1-pii',
        'd1:plugin-runner-id:d1-plugin-runner',
      ].map((targetId) => ({
        targetId,
        success: true,
        appliedCount: 1,
        skippedCount: 0,
      })),
    });
    mocks.listD1Databases.mockResolvedValue([
      { uuid: 'core-id', name: 'headless-authrim-core-db' },
      { uuid: 'pii-id', name: 'headless-authrim-pii-db' },
      { uuid: 'admin-id', name: 'headless-authrim-admin-db' },
      { uuid: 'control-id', name: 'headless-authrim-control-db' },
      { uuid: 'lookup-id', name: 'headless-authrim-lookup-db' },
      { uuid: 'plugin-runner-id', name: 'headless-authrim-plugin-runner-db' },
    ]);
    mocks.listKVNamespaces.mockResolvedValue(
      [
        'CLIENTS_CACHE',
        'INITIAL_ACCESS_TOKENS',
        'SETTINGS',
        'REBAC_CACHE',
        'USER_CACHE',
        'AUTHRIM_CONFIG',
        'TENANT_RUNTIME_REGISTRY',
        'STATE_STORE',
        'CONSENT_CACHE',
      ].map((binding) => ({
        id: `${binding.toLowerCase()}-id`,
        title: `HEADLESS-${binding}`,
      }))
    );
    mocks.listQueues.mockResolvedValue([]);
    mocks.listWorkers.mockResolvedValue([]);
    mocks.getWorkerDeployments.mockImplementation(async (name: string) => ({
      name,
      exists: false,
      lastDeployedAt: null,
      author: null,
      versionId: null,
      source: null,
    }));
    mocks.listR2Buckets.mockResolvedValue(
      ['headless', 'test'].flatMap((environment) =>
        [
          'migration-releases',
          'plugin-bundles',
          'public-assets',
          'diagnostic-logs',
          'audit-archive',
          'import-artifacts',
          'export-artifacts',
          'sensitive-details',
        ].map((suffix) => ({ name: `${environment}-${suffix}` }))
      )
    );
    mocks.queryD1Rows.mockResolvedValue([]);
    mocks.saveMasterWranglerConfigs.mockResolvedValue({ success: true, errors: [], files: [] });
    mocks.compileControlWorkerInventoryFromArtifacts.mockResolvedValue([]);
    mocks.registerControlWorkerInventory.mockResolvedValue({
      aggregateDigest: 'a'.repeat(64),
      operationId: `op_inventory_${'a'.repeat(32)}`,
      bootstrapSql: '',
      workerSql: [],
    });
    mocks.registerInitialControlTopology.mockResolvedValue({
      ownershipFingerprint: 'e'.repeat(64),
      manifestDigest: 'f'.repeat(64),
    });
    mocks.ensureInitialTenantRegionShardConfig.mockResolvedValue({
      created: true,
      config: {},
    });
    mocks.recordInitialBootstrapWorkerEvidence.mockResolvedValue({
      workerCount: CORE_WORKER_COMPONENTS.length,
      sourceVersions: CORE_WORKER_COMPONENTS.map((component) => `${component}:0.2.0`),
    });
    mocks.isInitialBootstrapHandoffAccepted.mockResolvedValue(false);
    mocks.waitForInitialBootstrapHandoff.mockResolvedValue({
      state: 'accepted',
      acceptedAt: 1,
    });
    mocks.requestInitialBootstrapAcceleration.mockResolvedValue('accepted');
    mocks.initializeControlKeyState.mockResolvedValue({
      initialized: true,
      operationId: `op_key_init_${'d'.repeat(32)}`,
      fingerprints: {
        runtimeRegistry: 'a'.repeat(64),
        smokeRpc: 'b'.repeat(64),
        lookupHmac: 'c'.repeat(64),
      },
    });
    mocks.reconcileLocalControlKeyFiles.mockResolvedValue(undefined);
    mocks.loadControlGeneratedKeyState.mockResolvedValue({
      runtimeRegistry: {
        activeSlot: 'A',
        activeKeyId: 'registry-v1',
        activeFingerprint: 'a'.repeat(64),
        updatedAt: 1,
      },
      smokeRpc: {
        activeSlot: 'A',
        activeKeyId: 'smoke-v1',
        activeFingerprint: 'b'.repeat(64),
        updatedAt: 1,
      },
      lookupHmac: {
        stateRevision: 1,
        activeGeneration: 1,
        activeSlot: 'A',
        activeKeyId: 'lookup-v1',
        activeFingerprint: 'c'.repeat(64),
        updatedAt: 1,
      },
    });
    mocks.loadControlStagedSigningKeys.mockResolvedValue([]);
    mocks.projectControlGeneratedKeyState.mockImplementation((lock, state) => ({
      lock: { ...lock, controlKeyState: state },
      changed: true,
    }));
    mocks.discoverExternalCapabilities.mockResolvedValue([]);
    mocks.registerExternalCapabilities.mockResolvedValue({
      aggregateDigest: 'b'.repeat(64),
      operationId: `op_external_${'b'.repeat(32)}`,
      sourceCount: 0,
      sql: '',
    });
    mocks.publishAndActivateMigrationRelease.mockImplementation(async () => ({
      artifact: {
        releaseId: '0.2.0',
        manifestDigest: 'c'.repeat(64),
        manifestObjectKey: `releases/0.2.0/${'c'.repeat(64)}/manifest.json`,
        streamIds: ['d1-core', 'd1-pii'],
        objects: [],
      },
      operationId: `op_release_${'c'.repeat(32)}`,
    }));
    mocks.checkWranglerStatus.mockResolvedValue([]);
    mocks.syncWranglerConfigs.mockResolvedValue({ success: true, errors: [], synced: [] });
    mocks.resolveExistingWorkerComponents.mockResolvedValue([]);
    mocks.resolveMissingUiWorkerBindingTargets.mockResolvedValue({
      loginUi: false,
      adminUi: false,
    });
    mocks.waitForWorkerDeploymentsReady.mockResolvedValue({ ready: true });
    mocks.waitForWorkerHttpReady.mockResolvedValue({ ready: true });
    mocks.buildWorkerHttpReadinessTargets.mockReturnValue([]);
    mocks.waitForRouterWorkerReady.mockResolvedValue({
      ready: true,
      checkedUrl: 'https://test.example.com/api/health',
    });
    mocks.waitForTenantRoutingReady.mockResolvedValue({
      ready: true,
      checkedUrl: 'https://test.example.com/.well-known/openid-configuration',
      issuer: 'https://test.example.com',
    });
    mocks.ensureInitialControlPlaneResources.mockResolvedValue({ success: true, skipped: true });
    mocks.ensureInitialTenantInD1.mockResolvedValue({ success: true });
    mocks.ensureInitialAdminRolesInD1.mockResolvedValue({ success: true });
    mocks.ensureSetupMachineAccessInD1.mockResolvedValue({ success: true });
    mocks.cleanupSetupMachineAccessInD1.mockResolvedValue({ success: true });
    mocks.seedDefaultCanonicalCatalog.mockResolvedValue({ success: true, seededCount: 0 });
    mocks.seedRuntimeProfiles.mockResolvedValue({
      success: true,
      seededCount: 0,
      backend: 'D1',
    });
    mocks.publishInitialControlPlaneRuntimeSnapshot.mockResolvedValue({
      success: true,
      skipped: true,
    });
    mocks.ensureInitialNotificationProviderConfiguration.mockResolvedValue({
      providerId: null,
      namespaces: ['authrim-platform', 'headless'],
    });
    mocks.completeInitialSetup.mockResolvedValue({ success: true, alreadyCompleted: true });
    mocks.configureDownstreamIntrospectionDeployment.mockResolvedValue({
      success: true,
      skipped: true,
    });
  });

  it('keeps every lock without productVersion in the initial or recovery state machine', () => {
    const base: AuthrimLock = {
      version: '1.0.0',
      env: 'headless',
      createdAt: '2026-08-31T00:00:00.000Z',
      d1: {},
      kv: {},
    };
    expect(isInitialDeploymentLock(base)).toBe(true);
    expect(
      isInitialDeploymentLock({
        ...base,
        workers: {
          'ar-auth': {
            name: 'headless-ar-auth',
            version: '0.2.0',
            cloudflareScriptTag: 'immutable-worker-tag',
          },
        },
      })
    ).toBe(true);
    expect(
      isInitialDeploymentLock({
        ...base,
        releaseUpdate: {
          targetVersion: '0.2.0',
          phase: 'verified',
          manifestChecksum: 'a'.repeat(64),
          startedAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:01.000Z',
          appliedTargets: [],
          manualTargets: [],
        },
      })
    ).toBe(true);
    expect(isInitialDeploymentLock({ ...base, productVersion: '0.2.0' })).toBe(false);
  });

  it('accepts only canonical versioned Worker evidence for explicit legacy initial recovery', () => {
    const base: AuthrimLock = {
      version: '1.0.0',
      env: 'headless',
      createdAt: '2026-08-31T00:00:00.000Z',
      d1: {},
      kv: {},
      workers: {
        'ar-auth': {
          name: 'headless-ar-auth',
          version: '0.2.0',
          cloudflareScriptTag: 'immutable-worker-tag',
        },
      },
    };
    expect(() =>
      assertExplicitLegacyInitialWorkerRecoveryState({
        lock: base,
        environment: 'headless',
        targetVersion: '0.2.0',
        enabledComponents: CORE_WORKER_COMPONENTS,
      })
    ).not.toThrow();
    expect(() =>
      assertExplicitLegacyInitialWorkerRecoveryState({
        lock: {
          ...base,
          workers: {
            'ar-auth': { ...base.workers!['ar-auth']!, version: '0.1.0' },
          },
        },
        environment: 'headless',
        targetVersion: '0.2.0',
        enabledComponents: CORE_WORKER_COMPONENTS,
      })
    ).toThrow('legacy_worker_recovery_state_invalid:ar-auth');
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  it('stops the prerequisite spinner when the Cloudflare check throws', async () => {
    mocks.isWranglerInstalled.mockRejectedValueOnce(new Error('wrangler check failed'));

    await expect(
      deployCommand({ env: 'headless', source: root, skipBuild: true, yes: true })
    ).rejects.toThrow('wrangler check failed');
    expect(
      mocks.oraSpinners.some((spinner) =>
        spinner.fail.mock.calls.some(([message]) => String(message).includes('An error occurred'))
      )
    ).toBe(true);
  });

  it('rejects a canonical config whose embedded environment differs from its directory', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.environment.prefix = 'another-environment';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'deployment_config_environment_mismatch'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('requires config recovery when only the canonical lock remains', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await rm(join(root, '.authrim', env, 'config.json'));

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'deployment_config_recovery_required'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
    expect(mocks.ensureInitialTenantInD1).not.toHaveBeenCalled();
  });

  it('does not fall through from an invalid canonical config to a valid legacy config', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const canonicalConfigPath = join(root, '.authrim', env, 'config.json');
    const validConfig = await readFile(canonicalConfigPath, 'utf-8');
    await writeFile(canonicalConfigPath, '{ invalid json\n');
    await mkdir(join(root, 'authrim'), { recursive: true });
    await writeFile(join(root, 'authrim', `authrim-${env}-config.json`), validConfig);

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'deployment_config_invalid'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit config without provider mutation', async () => {
    const configPath = join(root, 'broken-config.json');
    await writeFile(configPath, '{ invalid json\n');

    await expect(
      deployCommand({ config: configPath, source: root, skipBuild: true, yes: true })
    ).rejects.toThrow('deployment_config_invalid');

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it.each([
    [
      'mismatched',
      async () => {
        await writeFile(
          join(root, 'packages', 'ar-token', 'package.json'),
          JSON.stringify({ name: '@authrim/ar-token', version: '0.2.1' })
        );
      },
    ],
    [
      'missing',
      async () => {
        await rm(join(root, 'packages', 'ar-token', 'package.json'));
      },
    ],
  ])('rejects a %s required package before initial deployment mutation', async (_kind, mutate) => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await mutate();

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'deployment_workspace_version_mismatch:0.2.0:ar-token='
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
    expect(mocks.ensureInitialTenantInD1).not.toHaveBeenCalled();
    expect(mocks.writeControlProvisioningAuthority).not.toHaveBeenCalled();
  });

  it('requires an explicit environment when multiple canonical environments exist', async () => {
    await writeHeadlessEnvironment('first');
    await writeHeadlessEnvironment('second');

    await expect(deployCommand({ source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'deployment_environment_selection_ambiguous_use_env'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('includes a nested authrim checkout when rejecting ambiguous auto-detection', async () => {
    await writeHeadlessEnvironment('first');
    const nestedEnvironment = join(root, 'authrim', '.authrim', 'second');
    await mkdir(nestedEnvironment, { recursive: true });
    await writeFile(join(nestedEnvironment, 'config.json'), '{}\n');
    await writeFile(join(nestedEnvironment, 'lock.json'), '{}\n');

    await expect(deployCommand({ source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'deployment_environment_selection_ambiguous_use_env'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('rejects the same explicit environment under both parent and nested source roots', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const nestedEnvironment = join(root, 'authrim', '.authrim', env);
    await mkdir(nestedEnvironment, { recursive: true });
    await writeFile(join(nestedEnvironment, 'config.json'), '{}\n');
    await writeFile(join(nestedEnvironment, 'lock.json'), '{}\n');

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'deployment_environment_source_root_ambiguous'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('rejects an explicit canonical config path that belongs to another environment', async () => {
    const pathEnvironment = 'headless';
    await writeHeadlessEnvironment(pathEnvironment);
    const configPath = join(root, '.authrim', pathEnvironment, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.environment.prefix = 'another-environment';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await expect(
      deployCommand({ config: configPath, source: root, skipBuild: true, yes: true })
    ).rejects.toThrow('deployment_config_environment_mismatch');

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('rejects conflicting explicit config and environment options', async () => {
    await writeHeadlessEnvironment('first');
    const configPath = join(root, '.authrim', 'first', 'config.json');

    await expect(
      deployCommand({
        env: 'second',
        config: configPath,
        source: root,
        skipBuild: true,
        yes: true,
      })
    ).rejects.toThrow('deployment_config_environment_mismatch');

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('rejects a loaded lock whose embedded environment differs from the deployment target', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const lockPath = join(root, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.env = 'another-environment';
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'Lock environment identity mismatch'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('does not persist a discovered account ID before acquiring the environment lock', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const configPath = join(root, '.authrim', env, 'config.json');
    const initialConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(initialConfig.cloudflare?.accountId).toBeUndefined();
    const held = await acquireEnvironmentOperationLock(
      join(root, '.authrim', env, 'lock.json'),
      'concurrent-config-mutation'
    );
    try {
      await expect(
        deployCommand({ env, source: root, skipBuild: true, yes: true })
      ).rejects.toThrow('environment_operation_in_progress');
      const unchangedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(unchangedConfig.cloudflare?.accountId).toBeUndefined();
      expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
      expect(mocks.deployAll).not.toHaveBeenCalled();
    } finally {
      await held.release();
    }
  });

  it('stops the active deployment spinner when an operation throws unexpectedly', async () => {
    await writeHeadlessEnvironment('headless');
    mocks.applyReleaseSchemaUpdatePlan.mockRejectedValueOnce(
      new Error('unexpected schema executor failure')
    );

    await expect(
      deployCommand({ env: 'headless', source: root, skipBuild: true, yes: true })
    ).rejects.toThrow('unexpected schema executor failure');

    expect(
      mocks.oraSpinners.some((spinner) =>
        spinner.fail.mock.calls.some(([message]) => String(message).includes('Deployment failed'))
      )
    ).toBe(true);
    expect(mocks.oraSpinners.every((spinner) => spinner.isSpinning === false)).toBe(true);
  });

  it('applies schema before API Workers and keeps both UI Workers disabled', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const events: string[] = [];
    mocks.applyReleaseSchemaUpdatePlan.mockImplementation(async () => {
      events.push('schema');
      return {
        success: true,
        results: [
          'd1:admin-id:d1-admin',
          'd1:control-id:d1-control',
          'd1:core-id:d1-core',
          'd1:lookup-id:d1-lookup',
          'd1:pii-id:d1-pii',
          'd1:plugin-runner-id:d1-plugin-runner',
        ].map((targetId) => ({
          targetId,
          success: true,
          appliedCount: 1,
          skippedCount: 0,
        })),
      };
    });
    mocks.registerControlWorkerInventory.mockImplementation(async () => {
      events.push('inventory');
      return {
        aggregateDigest: 'a'.repeat(64),
        operationId: `op_inventory_${'a'.repeat(32)}`,
        bootstrapSql: '',
        workerSql: [],
      };
    });
    mocks.publishAndActivateMigrationRelease.mockImplementation(async () => {
      events.push('release');
      return {
        artifact: {
          releaseId: '0.2.0',
          manifestDigest: 'c'.repeat(64),
          manifestObjectKey: `releases/0.2.0/${'c'.repeat(64)}/manifest.json`,
          streamIds: ['d1-core', 'd1-pii'],
          objects: [],
        },
        operationId: `op_release_${'c'.repeat(32)}`,
      };
    });
    mocks.deployAll.mockImplementation(async (_options, components) => {
      events.push('workers');
      return successfulDeploymentSummary(env, components ?? CORE_WORKER_COMPONENTS);
    });

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
    });

    expect(events).toEqual(['schema', 'release', 'inventory', 'workers']);
    expect(mocks.applyReleaseSchemaUpdatePlan).toHaveBeenCalledOnce();
    expect(mocks.applyReleaseSchemaUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          automaticTargets: expect.arrayContaining([
            expect.objectContaining({ target: expect.objectContaining({ binding: 'DB' }) }),
            expect.objectContaining({ target: expect.objectContaining({ binding: 'DB_PII' }) }),
            expect.objectContaining({ target: expect.objectContaining({ binding: 'DB_ADMIN' }) }),
            expect.objectContaining({ target: expect.objectContaining({ binding: 'CONTROL_DB' }) }),
            expect.objectContaining({ target: expect.objectContaining({ binding: 'LOOKUP_DB' }) }),
            expect.objectContaining({
              target: expect.objectContaining({ binding: 'PLUGIN_RUNNER_DB' }),
            }),
          ]),
        }),
      })
    );
    expect(mocks.registerInitialControlTopology).toHaveBeenCalledOnce();
    expect(mocks.waitForInitialBootstrapHandoff).toHaveBeenCalledOnce();
    expect(mocks.recordInitialBootstrapWorkerEvidence).not.toHaveBeenCalled();
    const handoffInput = mocks.waitForInitialBootstrapHandoff.mock.calls[0]?.[0] as
      | {
          advanceBindings?: () => Promise<unknown>;
          refreshEvidence?: () => Promise<unknown>;
          pollIntervalMs?: number;
        }
      | undefined;
    expect(handoffInput?.timeoutMs).toBe(30 * 60_000);
    expect(handoffInput?.stallTimeoutMs).toBe(5 * 60_000);
    expect(handoffInput?.pollIntervalMs).toBe(2_000);
    expect(handoffInput?.advanceBindings).toEqual(expect.any(Function));
    await handoffInput?.advanceBindings?.();
    await handoffInput?.refreshEvidence?.();
    expect(mocks.requestInitialBootstrapAcceleration).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        activeSlot: 'A',
        activeKeyId: 'smoke-v1',
      })
    );
    expect(mocks.recordInitialBootstrapWorkerEvidence).toHaveBeenCalledOnce();
    expect(mocks.deployAll).toHaveBeenCalledWith(
      expect.objectContaining({
        deployConfigLockProof: expect.objectContaining({ assertOwned: expect.any(Function) }),
      }),
      CORE_WORKER_COMPONENTS
    );
    expect(mocks.resolveMissingUiWorkerBindingTargets).toHaveBeenCalledWith(expect.any(Object), {
      loginUi: false,
      adminUi: false,
    });
    expect(mocks.deployUiWorkerBindingTargets).not.toHaveBeenCalled();
    expect(mocks.deployAllUiWorkers).not.toHaveBeenCalled();
    expect(mocks.ensureAdminUiBffMachineAccessInD1).not.toHaveBeenCalled();
    expect(mocks.prepareAdminUiBffDeployment).not.toHaveBeenCalled();
    expect(mocks.ensureInitialTenantInD1).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(Function),
      { databaseIdentifier: 'core-id' }
    );
    expect(mocks.ensureInitialAdminRolesInD1).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(mocks.ensureSetupMachineAccessInD1).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(String),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(mocks.cleanupSetupMachineAccessInD1).toHaveBeenCalledWith(
      env,
      expect.any(String),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(mocks.seedDefaultCanonicalCatalog).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(Function),
      { databaseIdentifier: 'admin-id' }
    );
    expect(mocks.seedRuntimeProfiles).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.any(Function),
      { databaseIdentifier: 'core-id' }
    );

    const lock = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.productVersion).toBe('0.2.0');
    expect(lock.releaseUpdate?.phase).toBe('verified');
    expect(lock.workers['ar-login-ui']).toBeUndefined();
    expect(lock.workers['ar-admin-ui']).toBeUndefined();
  });

  it('does not verify a fresh deployment when notification provider bootstrap fails', async () => {
    const env = 'headless';
    const previousExitCode = process.exitCode;
    await writeHeadlessEnvironment(env);
    mocks.ensureInitialNotificationProviderConfiguration.mockRejectedValueOnce(
      new Error('notification provider configuration rejected')
    );

    try {
      await expect(
        deployCommand({
          env,
          source: root,
          skipBuild: true,
          yes: true,
          throwOnFailure: true,
        })
      ).rejects.toThrow('deploy_command_blocking_failure');

      const lock = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
      expect(lock.productVersion).toBeUndefined();
      expect(lock.releaseUpdate?.phase).toBe('workers_deployed');
      expect(mocks.ensureInitialNotificationProviderConfiguration).toHaveBeenCalledOnce();
      expect(mocks.cleanupSetupMachineAccessInD1).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('cleans the same exact DB_ADMIN after setup machine registration loses its response', async () => {
    const env = 'headless';
    const previousExitCode = process.exitCode;
    await writeHeadlessEnvironment(env);
    mocks.ensureSetupMachineAccessInD1.mockRejectedValueOnce(
      new Error('setup_machine_registration_response_lost')
    );

    try {
      await expect(
        deployCommand({
          env,
          source: root,
          skipBuild: true,
          yes: true,
          throwOnFailure: true,
        })
      ).rejects.toThrow('deploy_command_blocking_failure');

      expect(mocks.cleanupSetupMachineAccessInD1).toHaveBeenCalledWith(
        env,
        expect.any(String),
        expect.any(Function),
        { databaseIdentifier: 'admin-id' }
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('keeps setup machine-access cleanup retryable and verifies only after cleanup succeeds', async () => {
    const env = 'headless';
    const previousExitCode = process.exitCode;
    await writeHeadlessEnvironment(env);
    mocks.cleanupSetupMachineAccessInD1.mockResolvedValue({
      success: false,
      error: 'temporary principal revocation failed',
    });

    try {
      await expect(
        deployCommand({
          env,
          source: root,
          skipBuild: true,
          yes: true,
          throwOnFailure: true,
        })
      ).rejects.toThrow('setup_machine_access_cleanup_failed');

      const blockedLock = JSON.parse(
        await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')
      );
      expect(blockedLock.productVersion).toBeUndefined();
      expect(blockedLock.releaseUpdate?.phase).toBe('workers_deployed');
      // Two blocking attempts plus two best-effort attempts from the final cleanup guard.
      expect(mocks.cleanupSetupMachineAccessInD1).toHaveBeenCalledTimes(4);

      mocks.cleanupSetupMachineAccessInD1.mockClear();
      mocks.cleanupSetupMachineAccessInD1.mockResolvedValue({ success: true });
      await deployCommand({
        env,
        source: root,
        skipBuild: true,
        yes: true,
        throwOnFailure: true,
      });

      const verifiedLock = JSON.parse(
        await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')
      );
      expect(mocks.cleanupSetupMachineAccessInD1).toHaveBeenCalledOnce();
      expect(verifiedLock.productVersion).toBe('0.2.0');
      expect(verifiedLock.releaseUpdate?.phase).toBe('verified');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('accepts an idempotent setup machine-access cleanup retry that recovers in the same run', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.cleanupSetupMachineAccessInD1
      .mockRejectedValueOnce(new Error('Cloudflare authentication error [code: 10000]'))
      .mockResolvedValue({ success: true });

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
      throwOnFailure: true,
    });

    const lock = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(mocks.cleanupSetupMachineAccessInD1).toHaveBeenCalledTimes(2);
    expect(lock.productVersion).toBe('0.2.0');
    expect(lock.releaseUpdate?.phase).toBe('verified');
  });

  it('deploys without persistent Control tokens when Automatic provisioning is off', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.loadDeploySecretsFromKeys.mockResolvedValue({});

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
    });

    expect(mocks.applyReleaseSchemaUpdatePlan).toHaveBeenCalledOnce();
    expect(mocks.publishAndActivateMigrationRelease).toHaveBeenCalledOnce();
    expect(mocks.deployUiWorkerBindingTargets).not.toHaveBeenCalled();
    expect(mocks.deployAll).toHaveBeenCalledOnce();
    const handoffInput = mocks.waitForInitialBootstrapHandoff.mock.calls[0]?.[0] as
      | {
          advanceBindings?: () => Promise<unknown>;
          refreshEvidence?: () => Promise<unknown>;
          reconcile?: () => Promise<unknown>;
        }
      | undefined;
    expect(handoffInput?.advanceBindings).toEqual(expect.any(Function));
    expect(handoffInput?.refreshEvidence).toEqual(expect.any(Function));
    expect(handoffInput?.reconcile).toEqual(expect.any(Function));
    await handoffInput?.advanceBindings?.();
    await handoffInput?.refreshEvidence?.();
    await handoffInput?.reconcile?.();
    expect(mocks.advanceInitialBootstrapWorkerBindingsAsOperator).toHaveBeenCalledWith({
      controlDatabaseId: 'control-id',
      controlDatabaseName: 'control-id',
      environmentId: env,
      onProgress: expect.any(Function),
    });
    expect(mocks.reconcileInitialBootstrapHandoffAsOperator).toHaveBeenCalledWith({
      controlDatabaseId: 'control-id',
      executeWorkerBindings: false,
    });
  });

  it('keeps a fresh-install dry run mutation-free before the Control schema exists', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
      dryRun: true,
    });

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.ensureInitialControlPlaneResources).not.toHaveBeenCalled();
    expect(mocks.publishAndActivateMigrationRelease).not.toHaveBeenCalled();
    expect(mocks.deployAll).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
      CORE_WORKER_COMPONENTS
    );
  });

  it('fails before schema mutation when a same-name D1 has a different immutable ID', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const databases = (await mocks.listD1Databases()) as Array<{ uuid: string; name: string }>;
    mocks.listD1Databases.mockResolvedValue(
      databases.map((database) =>
        database.name === 'headless-authrim-core-db'
          ? { ...database, uuid: 'replacement-core-id' }
          : database
      )
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'cloudflare_resource_identity_mismatch'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
    expect(mocks.ensureInitialTenantInD1).not.toHaveBeenCalled();
    expect(mocks.ensureInitialAdminRolesInD1).not.toHaveBeenCalled();
    expect(mocks.ensureSetupMachineAccessInD1).not.toHaveBeenCalled();
    expect(mocks.cleanupSetupMachineAccessInD1).not.toHaveBeenCalled();
    expect(mocks.ensureAdminUiBffMachineAccessInD1).not.toHaveBeenCalled();
    expect(mocks.seedDefaultCanonicalCatalog).not.toHaveBeenCalled();
    expect(mocks.seedRuntimeProfiles).not.toHaveBeenCalled();
    expect(mocks.prepareAdminUiBffDeployment).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(persisted.d1.DB.id).toBe('core-id');
  });

  it('rejects a same-name replacement DB_ADMIN before single Login UI bootstrap', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const lockPath = join(root, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.productVersion = '0.2.0';
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.components.loginUi = true;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const draftManifest = await readFile(
      join(root, 'migrations', 'release-manifest.draft.json'),
      'utf-8'
    );
    await mkdir(join(root, 'migrations', 'releases'), { recursive: true });
    await writeFile(join(root, 'migrations', 'releases', '0.2.0.json'), draftManifest);
    const databases = (await mocks.listD1Databases()) as Array<{
      uuid: string;
      name: string;
    }>;
    mocks.listD1Databases.mockResolvedValue(
      databases.map((database) =>
        database.name === 'headless-authrim-admin-db'
          ? { ...database, uuid: 'replacement-admin-id' }
          : database
      )
    );

    await expect(
      deployCommand({
        env,
        source: root,
        component: 'ar-login-ui',
        yes: true,
      })
    ).rejects.toThrow('cloudflare_resource_identity_mismatch');

    expect(mocks.ensureInitialTenantInD1).not.toHaveBeenCalled();
    expect(mocks.ensureSetupMachineAccessInD1).not.toHaveBeenCalled();
    expect(mocks.cleanupSetupMachineAccessInD1).not.toHaveBeenCalled();
    expect(mocks.prepareAdminUiBffDeployment).not.toHaveBeenCalled();
  });

  it('fails before schema mutation when a same-name KV namespace has a different ID', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const namespaces = (await mocks.listKVNamespaces()) as Array<{ id: string; title: string }>;
    mocks.listKVNamespaces.mockResolvedValue(
      namespaces.map((namespace) =>
        namespace.title === 'HEADLESS-SETTINGS'
          ? { ...namespace, id: 'replacement-settings-id' }
          : namespace
      )
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'cloudflare_resource_identity_mismatch'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(persisted.kv.SETTINGS.id).toBe('settings-id');
  });

  it('explicitly recovers exact Worker ownership before resuming initial deployment', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const remoteSummary = successfulDeploymentSummary(env);
    mocks.listWorkers.mockResolvedValue(
      remoteSummary.results.map((result) => ({
        name: result.workerName,
        id: result.workerName,
        tag: result.cloudflareScriptTag,
      }))
    );
    mocks.getWorkerDeployments.mockImplementation(async (name: string) => {
      const result = remoteSummary.results.find((candidate) => candidate.workerName === name)!;
      return {
        name,
        exists: true,
        lastDeployedAt: result.deployedAt,
        author: 'operator@example.com',
        versionId: result.cloudflareVersionId,
        source: 'Upload',
      };
    });

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
      recoverLegacyWorkerDeployments: true,
    });

    const firstOwnershipCheck = mocks.prepareManagedWorkerScriptOwnership.mock.calls[0]?.[0];
    expect(firstOwnershipCheck.lock.workers['ar-auth']).toMatchObject({
      name: 'headless-ar-auth',
      version: '0.2.0',
      cloudflareVersionId: remoteSummary.results.find((result) => result.component === 'ar-auth')!
        .cloudflareVersionId,
      cloudflareScriptTag: remoteSummary.results.find((result) => result.component === 'ar-auth')!
        .cloudflareScriptTag,
    });
    expect(mocks.prepareManagedWorkerScriptOwnership.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.applyReleaseSchemaUpdatePlan).toHaveBeenCalledTimes(1);
    expect(mocks.deployAll).toHaveBeenCalledTimes(1);
  });

  it('recovers a partial legacy Worker lock without treating it as an installed release', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const lockPath = join(root, '.authrim', env, 'lock.json');
    const legacyLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const remoteSummary = successfulDeploymentSummary(env);
    const authWorker = remoteSummary.results.find((result) => result.component === 'ar-auth')!;
    legacyLock.workers = {
      'ar-auth': {
        name: authWorker.workerName,
        version: authWorker.version,
        deployedAt: authWorker.deployedAt,
        cloudflareVersionId: authWorker.cloudflareVersionId,
        cloudflareScriptTag: authWorker.cloudflareScriptTag,
      },
    };
    await writeFile(lockPath, `${JSON.stringify(legacyLock, null, 2)}\n`);
    mocks.listWorkers.mockResolvedValue(
      remoteSummary.results.map((result) => ({
        name: result.workerName,
        id: result.workerName,
        tag: result.cloudflareScriptTag,
      }))
    );
    mocks.getWorkerDeployments.mockImplementation(async (name: string) => {
      const result = remoteSummary.results.find((candidate) => candidate.workerName === name)!;
      return {
        name,
        exists: true,
        lastDeployedAt: result.deployedAt,
        author: 'operator@example.com',
        versionId: result.cloudflareVersionId,
        source: 'Upload',
      };
    });

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
      recoverLegacyWorkerDeployments: true,
    });

    expect(mocks.applyReleaseSchemaUpdatePlan).toHaveBeenCalledOnce();
    expect(mocks.deployAll).toHaveBeenCalledOnce();
    const verifiedLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(verifiedLock.productVersion).toBe('0.2.0');
    expect(verifiedLock.releaseUpdate.phase).toBe('verified');
  });

  it('forces a full redeploy after recovering a workers_deployed checkpoint', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.waitForInitialBootstrapHandoff.mockRejectedValueOnce(
      new Error('control_bootstrap_handoff_transient')
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'control_bootstrap_handoff_transient'
    );

    const lockPath = join(root, '.authrim', env, 'lock.json');
    const interruptedLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(interruptedLock.releaseUpdate.phase).toBe('workers_deployed');
    interruptedLock.workers = {};
    interruptedLock.workerScriptOwnership = {};
    await writeFile(lockPath, `${JSON.stringify(interruptedLock, null, 2)}\n`);

    const remoteSummary = successfulDeploymentSummary(env);
    mocks.listWorkers.mockResolvedValue(
      remoteSummary.results.map((result) => ({
        name: result.workerName,
        id: result.workerName,
        tag: result.cloudflareScriptTag,
      }))
    );
    mocks.getWorkerDeployments.mockImplementation(async (name: string) => {
      const result = remoteSummary.results.find((candidate) => candidate.workerName === name)!;
      return {
        name,
        exists: true,
        lastDeployedAt: result.deployedAt,
        author: 'operator@example.com',
        versionId: result.cloudflareVersionId,
        source: 'Upload',
      };
    });
    mocks.deployAll.mockClear();
    let checkpointDuringRedeploy: Record<string, unknown> | undefined;
    mocks.deployAll.mockImplementationOnce(async (_options, components) => {
      checkpointDuringRedeploy = JSON.parse(await readFile(lockPath, 'utf-8'));
      return successfulDeploymentSummary(env, components ?? CORE_WORKER_COMPONENTS);
    });

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
      recoverLegacyWorkerDeployments: true,
    });

    expect(mocks.deployAll).toHaveBeenCalledOnce();
    expect(
      (checkpointDuringRedeploy?.releaseUpdate as { initialWorkerRedeployRequired?: boolean })
        .initialWorkerRedeployRequired
    ).toBe(true);
    const verifiedLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(verifiedLock.releaseUpdate.phase).toBe('verified');
    expect(verifiedLock.releaseUpdate.initialWorkerRedeployRequired).toBeUndefined();
  });

  it('forces a full redeploy from a fully locked workers_deployed checkpoint', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.waitForInitialBootstrapHandoff.mockRejectedValueOnce(
      new Error('post_worker_bootstrap_transient')
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'post_worker_bootstrap_transient'
    );

    const lockPath = join(root, '.authrim', env, 'lock.json');
    const interruptedLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(interruptedLock.releaseUpdate.phase).toBe('workers_deployed');
    expect(Object.keys(interruptedLock.workers)).not.toHaveLength(0);
    mocks.deployAll.mockClear();
    mocks.registerInitialControlTopology.mockClear();
    mocks.applyReleaseSchemaUpdatePlan.mockClear();
    mocks.publishAndActivateMigrationRelease.mockClear();
    let checkpointDuringRedeploy: Record<string, unknown> | undefined;
    mocks.deployAll.mockImplementationOnce(async (_options, components) => {
      checkpointDuringRedeploy = JSON.parse(await readFile(lockPath, 'utf-8'));
      return successfulDeploymentSummary(env, components ?? CORE_WORKER_COMPONENTS);
    });

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
      recoverLegacyWorkerDeployments: true,
    });

    expect(mocks.deployAll).toHaveBeenCalledOnce();
    expect(mocks.registerInitialControlTopology).not.toHaveBeenCalled();
    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.publishAndActivateMigrationRelease).not.toHaveBeenCalled();
    expect(
      (checkpointDuringRedeploy?.releaseUpdate as { initialWorkerRedeployRequired?: boolean })
        .initialWorkerRedeployRequired
    ).toBe(true);
    const verifiedLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(verifiedLock.releaseUpdate.phase).toBe('verified');
    expect(verifiedLock.releaseUpdate.initialWorkerRedeployRequired).toBeUndefined();
  });

  it('does not recover a Worker automatically and preserves an empty lock on insufficient proof', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const remoteSummary = successfulDeploymentSummary(env);
    mocks.listWorkers.mockResolvedValue(
      remoteSummary.results.map((result) => ({
        name: result.workerName,
        id: result.workerName,
        tag: result.cloudflareScriptTag,
      }))
    );
    mocks.getWorkerDeployments.mockImplementation(async (name: string) => {
      const result = remoteSummary.results.find((candidate) => candidate.workerName === name)!;
      return {
        name,
        exists: true,
        lastDeployedAt: result.deployedAt,
        author: 'operator@example.com',
        versionId: result.cloudflareVersionId,
        source: null,
      };
    });

    await expect(
      deployCommand({
        env,
        source: root,
        skipBuild: true,
        yes: true,
        recoverLegacyWorkerDeployments: true,
      })
    ).rejects.toThrow('legacy_worker_recovery_evidence_insufficient_delete_or_recreate');
    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(persisted.workers).toEqual({});

    mocks.prepareManagedWorkerScriptOwnership.mockRejectedValueOnce(
      new Error('worker_script_fresh_name_conflict:headless-ar-auth')
    );
    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'worker_script_fresh_name_conflict:headless-ar-auth'
    );
    const unchanged = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(unchanged.workers).toEqual({});
  });

  it('requires dedicated confirmation before legacy Worker ownership recovery', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      recoverLegacyWorkerDeployments: true,
    });

    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.listWorkers).not.toHaveBeenCalled();
    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
  });

  it('fails before schema mutation when a same-name Queue has a different immutable ID', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await enableQueuesForHeadlessEnvironment(env);
    const queues = (await mocks.listQueues()) as Array<{ id: string; name: string }>;
    mocks.listQueues.mockResolvedValue(
      queues.map((queue) =>
        queue.name === 'headless-audit-queue' ? { ...queue, id: 'queue-replacement-id' } : queue
      )
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'cloudflare_resource_identity_mismatch'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(persisted.queues.AUDIT_QUEUE.id).toBe('queue-audit_queue-id');
  });

  it('does not automatically adopt legacy Queue id==name sentinels', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await enableLegacyQueueSentinelsForHeadlessEnvironment(env);

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'cloudflare_resource_identity_mismatch'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(persisted.queues.AUDIT_QUEUE.id).toBe('headless-audit-queue');
  });

  it('explicitly checkpoints exact legacy Queue identities and continues deployment', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await enableLegacyQueueSentinelsForHeadlessEnvironment(env);

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      yes: true,
      adoptLegacyQueueIdentities: true,
    });

    const persisted = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(persisted.queues.AUDIT_QUEUE.id).toBe('queue-audit_queue-id');
    expect(persisted.queues.LOGGING_DELIVERY_QUEUE.id).toBe('queue-logging_delivery_queue-id');
    expect(mocks.applyReleaseSchemaUpdatePlan).toHaveBeenCalledTimes(1);
    expect(mocks.deployAll).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy Queue checkpoint unchanged when provider inventory is ambiguous', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await enableLegacyQueueSentinelsForHeadlessEnvironment(env);
    const queues = (await mocks.listQueues()) as Array<{ id: string; name: string }>;
    mocks.listQueues.mockResolvedValue([...queues, queues[0]]);

    await expect(
      deployCommand({
        env,
        source: root,
        skipBuild: true,
        yes: true,
        adoptLegacyQueueIdentities: true,
      })
    ).rejects.toThrow('cloudflare_resource_reconciliation_failed');

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(persisted.queues.AUDIT_QUEUE.id).toBe('headless-audit-queue');
  });

  it('requires a dedicated confirmation before legacy Queue identity adoption', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await enableLegacyQueueSentinelsForHeadlessEnvironment(env);
    mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      adoptLegacyQueueIdentities: true,
    });

    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.listQueues).not.toHaveBeenCalled();
    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
  });

  it('fails before schema mutation when Queue inventory cannot prove an immutable ID', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await enableQueuesForHeadlessEnvironment(env);
    const queues = (await mocks.listQueues()) as Array<{ id?: string; name: string }>;
    mocks.listQueues.mockResolvedValue(
      queues.map((queue) => (queue.name === 'headless-audit-queue' ? { name: queue.name } : queue))
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'cloudflare_resource_identity_mismatch'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('fails before schema mutation when a locked required Queue is missing', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    await enableQueuesForHeadlessEnvironment(env);
    const queues = (await mocks.listQueues()) as Array<{ id: string; name: string }>;
    mocks.listQueues.mockResolvedValue(
      queues.filter((queue) => queue.name !== 'headless-audit-queue')
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'required_cloudflare_resources_missing'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('fails before schema mutation when the migration release R2 bucket is missing', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.listR2Buckets.mockResolvedValue([]);

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'required_cloudflare_resources_missing'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.publishAndActivateMigrationRelease).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('resumes a failed initial handoff without uploading or promoting Worker code again', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.components.loginUi = true;
    config.components.adminUi = true;
    config.urls = {
      api: { custom: null, auto: `https://${env}-ar-router.example.workers.dev` },
      loginUi: { custom: null, auto: `https://${env}-ar-login-ui.example.workers.dev` },
      adminUi: {
        custom: null,
        auto: `https://${env}-ar-admin-ui.example.workers.dev`,
        sameAsApi: false,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    mocks.waitForInitialBootstrapHandoff.mockRejectedValueOnce(
      new Error('control_bootstrap_handoff_transient')
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'control_bootstrap_handoff_transient'
    );

    const checkpoint = JSON.parse(
      await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')
    );
    expect(checkpoint.releaseUpdate.phase).toBe('workers_deployed');
    expect(checkpoint.workers['ar-control'].cloudflareVersionId).toMatch(/^[a-f0-9-]{36}$/u);

    mocks.deployAll.mockClear();
    mocks.reconcileWorkerCronTriggers.mockClear();
    mocks.applyReleaseSchemaUpdatePlan.mockClear();
    mocks.publishAndActivateMigrationRelease.mockClear();
    mocks.isInitialBootstrapHandoffAccepted.mockResolvedValue(true);
    mocks.waitForInitialBootstrapHandoff.mockResolvedValue({ state: 'accepted', acceptedAt: 2 });

    await deployCommand({ env, source: root, skipBuild: true, yes: true });

    expect(mocks.deployAll).not.toHaveBeenCalled();
    expect(mocks.reconcileWorkerCronTriggers).toHaveBeenCalledOnce();
    expect(mocks.reconcileWorkerCronTriggers).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        cloudflareAccountId: TEST_ACCOUNT_ID,
        workerScriptOwnership: expect.objectContaining({
          assertBeforeMutation: expect.any(Function),
        }),
      }),
      expect.arrayContaining(['ar-management'])
    );
    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.isInitialBootstrapHandoffAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: env })
    );
    expect(mocks.recordInitialBootstrapWorkerEvidence).not.toHaveBeenCalled();
    expect(
      mocks.prepareManagedWorkerScriptOwnership.mock.calls.some(([input]) => {
        const targets = input.targets as Array<{ component: string }>;
        return (
          targets.some((target) => target.component === 'ar-login-ui') &&
          targets.some((target) => target.component === 'ar-admin-ui')
        );
      })
    ).toBe(true);
  });

  it('requires recreation without mutating schema or Workers when the draft manifest changed', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.waitForInitialBootstrapHandoff.mockRejectedValueOnce(
      new Error('control_bootstrap_handoff_transient')
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'control_bootstrap_handoff_transient'
    );

    const lockPath = join(root, '.authrim', env, 'lock.json');
    const checkpoint = JSON.parse(await readFile(lockPath, 'utf-8'));
    checkpoint.releaseUpdate.manifestChecksum = 'f'.repeat(64);
    await writeFile(lockPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

    mocks.deployAll.mockClear();
    mocks.applyReleaseSchemaUpdatePlan.mockClear();
    mocks.publishAndActivateMigrationRelease.mockClear();
    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'process.exit unexpectedly called with "1"'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.publishAndActivateMigrationRelease).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
    const unchanged = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(unchanged.releaseUpdate.manifestChecksum).toBe('f'.repeat(64));
  });

  it('preserves append-only draft evidence after a migration failure and advances it on retry', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const { oldManifestChecksum, currentManifestChecksum } =
      await prepareAppendOnlyDraftCheckpoint(env);
    const lockPath = join(root, '.authrim', env, 'lock.json');
    mocks.applyReleaseSchemaUpdatePlan.mockResolvedValueOnce({
      success: false,
      results: [
        {
          targetId: 'd1:control-id:d1-control',
          success: false,
          appliedCount: 1,
          skippedCount: 0,
          error: 'injected_transient_failure',
        },
      ],
    });

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'initial_release_schema_failed'
    );

    const failedCheckpoint = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(failedCheckpoint.releaseUpdate).toMatchObject({
      phase: 'schema_applied',
      manifestChecksum: oldManifestChecksum,
    });
    expect(failedCheckpoint.schemaTargets['d1:control-id:d1-control']).toMatchObject({
      manifestChecksum: oldManifestChecksum,
      files: [expect.objectContaining({ path: '001_initial.sql' })],
    });

    process.exitCode = undefined;
    mocks.applyReleaseSchemaUpdatePlan.mockImplementationOnce(async () => {
      const checkpointAtRetry = JSON.parse(await readFile(lockPath, 'utf-8'));
      expect(checkpointAtRetry.releaseUpdate).toMatchObject({
        phase: 'schema_applied',
        manifestChecksum: oldManifestChecksum,
      });
      return {
        success: true,
        results: [
          'd1:admin-id:d1-admin',
          'd1:control-id:d1-control',
          'd1:core-id:d1-core',
          'd1:lookup-id:d1-lookup',
          'd1:pii-id:d1-pii',
          'd1:plugin-runner-id:d1-plugin-runner',
        ].map((targetId) => ({
          targetId,
          success: true,
          appliedCount: 1,
          skippedCount: 0,
        })),
      };
    });
    mocks.publishAndActivateMigrationRelease.mockRejectedValueOnce(
      new Error('injected_stop_after_schema_checkpoint')
    );

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'injected_stop_after_schema_checkpoint'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).toHaveBeenCalledTimes(2);
    expect(mocks.deployAll).not.toHaveBeenCalled();
    const retriedCheckpoint = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(retriedCheckpoint.releaseUpdate).toMatchObject({
      phase: 'schema_applied',
      manifestChecksum: currentManifestChecksum,
    });
    expect(retriedCheckpoint.schemaTargets['d1:control-id:d1-control']).toMatchObject({
      manifestChecksum: currentManifestChecksum,
      files: [
        expect.objectContaining({ path: '001_initial.sql' }),
        expect.objectContaining({ path: '002_appended.sql' }),
      ],
    });
  });

  it('rejects an incomplete or cross-environment handoff checkpoint', () => {
    expect(() =>
      buildInitialHandoffResumeSummary({
        lock: {
          version: '1.0.0',
          env: 'test',
          createdAt: '2026-07-22T00:00:00.000Z',
          d1: {},
          kv: {},
          workers: {
            'ar-control': {
              name: 'other-ar-control',
              deployedAt: '2026-07-22T01:00:00.000Z',
              cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
              cloudflareScriptTag: 'immutable-worker-tag-control',
            },
          },
        },
        components: ['ar-control'],
      })
    ).toThrow('initial_handoff_resume_worker_evidence_missing:ar-control');
  });

  it('fails before schema mutation when Automatic provisioning lacks split tokens noninteractively', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env, true);
    mocks.loadDeploySecretsFromKeys.mockResolvedValue({});

    await expect(deployCommand({ env, source: root, skipBuild: true, yes: true })).rejects.toThrow(
      'Non-interactive setup cannot prompt for a one-time bootstrap token'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.publishAndActivateMigrationRelease).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
  });

  it('uses and consumes an explicit bootstrap token file in a non-interactive initial deploy', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env, true);
    mocks.loadDeploySecretsFromKeys.mockResolvedValue({
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-v1',
      SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
    });
    mocks.queryD1Rows.mockImplementation(async (_databaseName, sql: string) =>
      sql.includes('provisioning_token_management')
        ? [controlProvisioningAuthorityRow(env, controlBootstrapCompleted ? 'ready' : 'tokenless')]
        : []
    );
    const tokenPath = join(root, 'bootstrap-token');
    const bootstrapToken = 'one-time-bootstrap-token-value';
    await writeFile(tokenPath, bootstrapToken, { mode: 0o600 });
    const previousApiToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = 'operator-token-used-only-for-ownership-selection';

    try {
      await deployCommand({
        env,
        source: root,
        skipBuild: true,
        yes: true,
        cloudflareBootstrapTokenFile: tokenPath,
      });
    } finally {
      if (previousApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previousApiToken;
    }

    await expect(readFile(tokenPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.detectCloudflareTokenOwnership).toHaveBeenCalledWith({
      accountId: TEST_ACCOUNT_ID,
      token: bootstrapToken,
    });
    expect(mocks.completeControlTokenBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapToken, ownership: 'user' })
    );
    expect(mocks.deployAll).toHaveBeenCalledOnce();
  });

  it('resumes a staged pre-authority Control generation without prompting or issuing a token', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env, true);
    const configPath = join(root, '.authrim', env, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    config.cloudflare.accountId = TEST_ACCOUNT_ID;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const lockPath = join(root, '.authrim', env, 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const draft = JSON.parse(
      await readFile(join(root, 'migrations', 'release-manifest.draft.json'), 'utf-8')
    );
    lock.releaseUpdate = {
      targetVersion: '0.2.0',
      phase: 'planned',
      manifestChecksum: calculateReleaseManifestChecksum(draft),
      startedAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await stageRecoverableControlBootstrap(env);
    mocks.loadDeploySecretsFromKeys.mockResolvedValue({
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
      TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-v1',
      SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
    });
    mocks.queryD1Rows.mockImplementation(async (_databaseName, sql: string) =>
      sql.includes('provisioning_token_management')
        ? [controlProvisioningAuthorityRow(env, controlBootstrapCompleted ? 'ready' : 'tokenless')]
        : []
    );

    await expect(
      deployCommand({ env, source: root, skipBuild: true, yes: true })
    ).resolves.toBeUndefined();

    expect(mocks.completeControlTokenBootstrap).toHaveBeenCalledOnce();
    const bootstrapCall = mocks.completeControlTokenBootstrap.mock.calls[0]?.[0];
    expect(bootstrapCall).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      environment: env,
      ownership: 'account',
    });
    expect(bootstrapCall).not.toHaveProperty('bootstrapToken');
    expect(mocks.validateDirectControlTokensWithEvidence).not.toHaveBeenCalled();
  });

  it('does not query the empty Control D1 during a fresh Automatic provisioning deploy', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env, true);
    const events: string[] = [];
    mocks.queryD1Rows.mockImplementation(async () => {
      events.push('query');
      return [];
    });
    mocks.applyReleaseSchemaUpdatePlan.mockImplementation(async () => {
      events.push('schema');
      return {
        success: true,
        results: [
          'd1:admin-id:d1-admin',
          'd1:control-id:d1-control',
          'd1:core-id:d1-core',
          'd1:lookup-id:d1-lookup',
          'd1:pii-id:d1-pii',
          'd1:plugin-runner-id:d1-plugin-runner',
        ].map((targetId) => ({
          targetId,
          success: true,
          appliedCount: 1,
          skippedCount: 0,
        })),
      };
    });

    const previousD1Token = process.env.CLOUDFLARE_D1_API_TOKEN;
    const previousWorkersToken = process.env.CLOUDFLARE_WORKERS_API_TOKEN;
    process.env.CLOUDFLARE_D1_API_TOKEN = 'd1-token';
    process.env.CLOUDFLARE_WORKERS_API_TOKEN = 'workers-token';
    try {
      await deployCommand({ env, source: root, skipBuild: true, yes: true });
    } finally {
      if (previousD1Token === undefined) delete process.env.CLOUDFLARE_D1_API_TOKEN;
      else process.env.CLOUDFLARE_D1_API_TOKEN = previousD1Token;
      if (previousWorkersToken === undefined) delete process.env.CLOUDFLARE_WORKERS_API_TOKEN;
      else process.env.CLOUDFLARE_WORKERS_API_TOKEN = previousWorkersToken;
    }

    expect(mocks.applyReleaseSchemaUpdatePlan).toHaveBeenCalledOnce();
    expect(mocks.deployAll).toHaveBeenCalledOnce();
    const handoffInput = mocks.waitForInitialBootstrapHandoff.mock.calls[0]?.[0] as
      | {
          advanceBindings?: () => Promise<unknown>;
          pollIntervalMs?: number;
        }
      | undefined;
    expect(handoffInput?.timeoutMs).toBe(30 * 60_000);
    expect(handoffInput?.stallTimeoutMs).toBe(5 * 60_000);
    expect(handoffInput?.pollIntervalMs).toBe(2_000);
    expect(handoffInput?.advanceBindings).toEqual(expect.any(Function));
    await handoffInput?.advanceBindings?.();
    expect(mocks.requestInitialBootstrapAcceleration).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        activeSlot: 'A',
        activeKeyId: 'smoke-v1',
      })
    );
    const schemaIndex = events.indexOf('schema');
    const firstQueryIndex = events.indexOf('query');
    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    expect(firstQueryIndex === -1 || firstQueryIndex > schemaIndex).toBe(true);
    expect(mocks.writeControlProvisioningAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        tokenOwnership: 'user',
        tokenManagement: 'operator',
        capabilityState: 'ready',
        childTokens: expect.arrayContaining([
          expect.objectContaining({
            resourceClass: 'd1',
            tokenId: '2'.repeat(32),
          }),
          expect.objectContaining({
            resourceClass: 'workers',
            tokenId: '3'.repeat(32),
          }),
        ]),
        secretGeneration: expect.objectContaining({
          deploymentId: 'control-deployment-id',
        }),
      })
    );
  });

  it('fails closed before marking direct tokens ready when the active Control version differs', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env, true);
    mocks.readActiveControlSecretGeneration.mockResolvedValueOnce({
      deploymentId: 'unexpected-deployment',
      versionId: 'unexpected-version',
    });
    const previousD1Token = process.env.CLOUDFLARE_D1_API_TOKEN;
    const previousWorkersToken = process.env.CLOUDFLARE_WORKERS_API_TOKEN;
    process.env.CLOUDFLARE_D1_API_TOKEN = 'd1-token';
    process.env.CLOUDFLARE_WORKERS_API_TOKEN = 'workers-token';
    try {
      await expect(
        deployCommand({ env, source: root, skipBuild: true, yes: true })
      ).rejects.toThrow('control_direct_token_secret_generation_mismatch');
    } finally {
      if (previousD1Token === undefined) delete process.env.CLOUDFLARE_D1_API_TOKEN;
      else process.env.CLOUDFLARE_D1_API_TOKEN = previousD1Token;
      if (previousWorkersToken === undefined) delete process.env.CLOUDFLARE_WORKERS_API_TOKEN;
      else process.env.CLOUDFLARE_WORKERS_API_TOKEN = previousWorkersToken;
    }
    expect(mocks.writeControlProvisioningAuthority).not.toHaveBeenCalled();
  });

  it('keeps optional introspection failures diagnostic and does not print undefined guidance', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.configureDownstreamIntrospectionDeployment.mockResolvedValueOnce({
      success: false,
      error: 'secret write failed',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deployCommand({ env, source: root, skipBuild: true, yes: true });
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('Reason: secret write failed');
      expect(output).toContain('Core login, Admin UI, and token issuance remain available.');
      expect(output).not.toContain('undefined');
      expect(
        mocks.oraSpinners.some((spinner) =>
          spinner.warn.mock.calls.some(([message]) =>
            String(message).includes('Optional downstream grant introspection was deferred')
          )
        )
      ).toBe(true);
      expect(mocks.configureDownstreamIntrospectionDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          knownRouterReadyBaseUrls: expect.arrayContaining([expect.any(String)]),
        })
      );
    } finally {
      log.mockRestore();
    }
  });

  it('defers an unexpected optional introspection exception without failing core deployment', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    mocks.configureDownstreamIntrospectionDeployment.mockRejectedValueOnce(
      new Error('unexpected downstream failure')
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(
        deployCommand({ env, source: root, skipBuild: true, yes: true })
      ).resolves.toBeUndefined();
      expect(log.mock.calls.flat().join('\n')).toContain('Reason: unexpected downstream failure');
      expect(
        mocks.oraSpinners.some((spinner) =>
          spinner.warn.mock.calls.some(([message]) =>
            String(message).includes('Optional downstream grant introspection was deferred')
          )
        )
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('prints the completion banner only after durable initial release verification is saved', async () => {
    const source = await readFile(new URL('../cli/commands/deploy.ts', import.meta.url), 'utf-8');
    const verification = source.indexOf('currentLock = withVerifiedInitialReleaseState(');
    const verifiedSave = source.indexOf('await saveLockFile(currentLock, lockPath);', verification);
    const completionBanner = source.indexOf('━━━ Deployment Complete ━━━', verifiedSave);

    expect(verification).toBeGreaterThanOrEqual(0);
    expect(verifiedSave).toBeGreaterThan(verification);
    expect(completionBanner).toBeGreaterThan(verifiedSave);
  });
});
