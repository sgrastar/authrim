import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { CORE_WORKER_COMPONENTS } from '../core/naming.js';

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
  buildApiPackages: vi.fn(),
  loadDeploySecretsFromKeys: vi.fn(),
  deployAll: vi.fn(),
  deployAllUiWorkers: vi.fn(),
  deployUiWorkerBindingTargets: vi.fn(),
  resolveExistingWorkerComponents: vi.fn(),
  resolveMissingUiWorkerBindingTargets: vi.fn(),
  isWranglerInstalled: vi.fn(),
  checkAuth: vi.fn(),
  validateDirectControlTokens: vi.fn(),
  writeControlProvisioningAuthority: vi.fn(),
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
  confirm: vi.fn(async () => true),
  select: vi.fn(async () => 'overwrite'),
}));

vi.mock('../core/deploy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/deploy.js')>();
  return {
    ...actual,
    buildApiPackages: mocks.buildApiPackages,
    deployAll: mocks.deployAll,
    deployAllUiWorkers: mocks.deployAllUiWorkers,
    deployUiWorkerBindingTargets: mocks.deployUiWorkerBindingTargets,
    loadDeploySecretsFromKeys: mocks.loadDeploySecretsFromKeys,
    resolveExistingWorkerComponents: mocks.resolveExistingWorkerComponents,
    resolveMissingUiWorkerBindingTargets: mocks.resolveMissingUiWorkerBindingTargets,
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
    queryD1Rows: mocks.queryD1Rows,
  };
});

vi.mock('../core/cloudflare-control-token-bootstrap.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/cloudflare-control-token-bootstrap.js')>();
  return {
    ...actual,
    validateDirectControlTokens: mocks.validateDirectControlTokens,
  };
});

vi.mock('../core/control-provisioning-authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/control-provisioning-authority.js')>();
  return {
    ...actual,
    writeControlProvisioningAuthority: mocks.writeControlProvisioningAuthority,
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

import { buildInitialHandoffResumeSummary, deployCommand } from '../cli/commands/deploy.js';
import { initI18n } from '../i18n/index.js';

const originalCwd = process.cwd();
let root: string;

async function writeHeadlessEnvironment(env: string, automaticProvisioning = false): Promise<void> {
  const config = createDefaultConfig(env);
  config.components.loginUi = false;
  config.components.adminUi = false;
  config.controlPlane = { automaticProvisioning };

  await mkdir(join(root, '.authrim', env), { recursive: true });
  await mkdir(join(root, 'packages', 'ar-auth'), { recursive: true });
  await mkdir(join(root, 'packages', 'ar-lib-core'), { recursive: true });
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

function successfulDeploymentSummary(
  env: string,
  components: readonly (typeof CORE_WORKER_COMPONENTS)[number][] = CORE_WORKER_COMPONENTS
) {
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
    startedAt: '2026-07-22T01:00:00.000Z',
    completedAt: '2026-07-22T01:00:00.000Z',
    duration: 0,
  };
}

describe('CLI initial deployment', () => {
  beforeEach(async () => {
    await initI18n('en');
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-cli-initial-deploy-')));
    process.chdir(root);
    vi.clearAllMocks();
    mocks.oraSpinners.length = 0;

    mocks.isWranglerInstalled.mockResolvedValue(true);
    mocks.checkAuth.mockResolvedValue({
      isLoggedIn: true,
      email: 'test@example.com',
      accountId: '0123456789abcdef0123456789abcdef',
    });
    mocks.validateDirectControlTokens.mockResolvedValue('user');
    mocks.writeControlProvisioningAuthority.mockResolvedValue(undefined);
    mocks.getWorkersSubdomain.mockResolvedValue('example-subdomain');
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
    expect(mocks.requestInitialBootstrapAcceleration).not.toHaveBeenCalled();
    expect(mocks.recordInitialBootstrapWorkerEvidence).toHaveBeenCalledOnce();
    expect(mocks.deployAll).toHaveBeenCalledWith(expect.any(Object), CORE_WORKER_COMPONENTS);
    expect(mocks.resolveMissingUiWorkerBindingTargets).toHaveBeenCalledWith(expect.any(Object), {
      loginUi: false,
      adminUi: false,
    });
    expect(mocks.deployUiWorkerBindingTargets).not.toHaveBeenCalled();
    expect(mocks.deployAllUiWorkers).not.toHaveBeenCalled();
    expect(mocks.ensureAdminUiBffMachineAccessInD1).not.toHaveBeenCalled();
    expect(mocks.prepareAdminUiBffDeployment).not.toHaveBeenCalled();

    const lock = JSON.parse(await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.productVersion).toBe('0.2.0');
    expect(lock.releaseUpdate?.phase).toBe('verified');
    expect(lock.workers['ar-login-ui']).toBeUndefined();
    expect(lock.workers['ar-admin-ui']).toBeUndefined();
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
      controlDatabaseName: 'headless-authrim-control-db',
      environmentId: env,
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

  it('resumes a failed initial handoff without uploading or promoting Worker code again', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
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
    mocks.applyReleaseSchemaUpdatePlan.mockClear();
    mocks.publishAndActivateMigrationRelease.mockClear();
    mocks.isInitialBootstrapHandoffAccepted.mockResolvedValue(true);
    mocks.waitForInitialBootstrapHandoff.mockResolvedValue({ state: 'accepted', acceptedAt: 2 });

    await deployCommand({ env, source: root, skipBuild: true, yes: true });

    expect(mocks.deployAll).not.toHaveBeenCalled();
    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.isInitialBootstrapHandoffAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: env })
    );
    expect(mocks.recordInitialBootstrapWorkerEvidence).not.toHaveBeenCalled();
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
      'process.exit unexpectedly called with "1"'
    );

    expect(mocks.applyReleaseSchemaUpdatePlan).not.toHaveBeenCalled();
    expect(mocks.publishAndActivateMigrationRelease).not.toHaveBeenCalled();
    expect(mocks.deployAll).not.toHaveBeenCalled();
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
});
