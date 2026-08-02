import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';

const buildApiPackagesMock = vi.hoisted(() => vi.fn());
const deployAllMock = vi.hoisted(() => vi.fn());
const deployAllUiWorkersMock = vi.hoisted(() => vi.fn());
const deployWorkerMock = vi.hoisted(() => vi.fn());
const deployUiWorkerBindingTargetsMock = vi.hoisted(() => vi.fn());
const resolveExistingWorkerComponentsMock = vi.hoisted(() => vi.fn());
const resolveMissingUiWorkerBindingTargetsMock = vi.hoisted(() => vi.fn());
const loadDeploySecretsFromKeysMock = vi.hoisted(() => vi.fn());
const getWorkersSubdomainMock = vi.hoisted(() => vi.fn());
const saveMasterWranglerConfigsMock = vi.hoisted(() => vi.fn());
const syncWranglerConfigsMock = vi.hoisted(() => vi.fn());
const buildWorkerHttpReadinessTargetsMock = vi.hoisted(() => vi.fn());
const waitForRouterWorkerReadyMock = vi.hoisted(() => vi.fn());
const waitForWorkerDeploymentsReadyMock = vi.hoisted(() => vi.fn());
const waitForWorkerHttpReadyMock = vi.hoisted(() => vi.fn());
const configureDownstreamIntrospectionDeploymentMock = vi.hoisted(() => vi.fn());
const ensureInitialTenantD1ResourcesMock = vi.hoisted(() => vi.fn());
const ensureInitialTenantRegionShardConfigMock = vi.hoisted(() => vi.fn());
const publishInitialTenantD1RuntimeSnapshotMock = vi.hoisted(() => vi.fn());
const ensureInitialNotificationProviderConfigurationMock = vi.hoisted(() => vi.fn());
const runMigrationsForEnvironmentMock = vi.hoisted(() => vi.fn());
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
const recordInitialBootstrapWorkerEvidenceMock = vi.hoisted(() => vi.fn());
const waitForInitialBootstrapHandoffMock = vi.hoisted(() => vi.fn());
const discoverExternalCapabilitiesMock = vi.hoisted(() => vi.fn());
const registerExternalCapabilitiesMock = vi.hoisted(() => vi.fn());
const publishDynamicPluginWorkerBundlesMock = vi.hoisted(() => vi.fn());
const queryD1RowsMock = vi.hoisted(() => vi.fn());

vi.mock('../core/deploy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/deploy.js')>();
  return {
    ...actual,
    buildApiPackages: buildApiPackagesMock,
    deployAll: deployAllMock,
    deployAllUiWorkers: deployAllUiWorkersMock,
    deployWorker: deployWorkerMock,
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
    runMigrationsForEnvironment: runMigrationsForEnvironmentMock,
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

vi.mock('../core/downstream-introspection-deploy.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/downstream-introspection-deploy.js')>();
  return {
    ...actual,
    configureDownstreamIntrospectionDeployment: configureDownstreamIntrospectionDeploymentMock,
  };
});

vi.mock('../core/tenant-d1-bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/tenant-d1-bootstrap.js')>();
  return {
    ...actual,
    ensureInitialTenantD1Resources: ensureInitialTenantD1ResourcesMock,
    ensureInitialTenantRegionShardConfig: ensureInitialTenantRegionShardConfigMock,
    publishInitialTenantD1RuntimeSnapshot: publishInitialTenantD1RuntimeSnapshotMock,
  };
});

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
  recordInitialBootstrapWorkerEvidence: recordInitialBootstrapWorkerEvidenceMock,
  waitForInitialBootstrapHandoff: waitForInitialBootstrapHandoffMock,
}));

vi.mock('../core/external-capability-registration.js', () => ({
  discoverExternalCapabilities: discoverExternalCapabilitiesMock,
  registerExternalCapabilities: registerExternalCapabilitiesMock,
}));

vi.mock('../core/dynamic-plugin-publication.js', () => ({
  publishDynamicPluginWorkerBundles: publishDynamicPluginWorkerBundlesMock,
}));

import { createApiRoutes, generateSessionToken } from '../web/api.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function writeEnvironment(env: string) {
  const envDir = join(tempDir!, '.authrim', env);
  await mkdir(envDir, { recursive: true });
  const config = createDefaultConfig(env);
  config.profiles.defaults.storage = 'builtin:storage:shared-d1';
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
        d1: {},
        kv: {},
        workers: {
          'ar-auth': {
            name: `${env}-ar-auth`,
            deployedAt: '2026-05-18T00:00:00.000Z',
            version: '0.1.0',
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
        formatVersion: 1,
        productVersion: '0.2.0',
        streams: [
          { id: 'd1-core', dialect: 'sqlite', logicalRoles: ['core'], files: [] },
          { id: 'd1-pii', dialect: 'sqlite', logicalRoles: ['pii'], files: [] },
          { id: 'd1-admin', dialect: 'sqlite', logicalRoles: ['admin'], files: [] },
          { id: 'd1-control', dialect: 'sqlite', logicalRoles: ['control'], files: [] },
          { id: 'd1-lookup', dialect: 'sqlite', logicalRoles: ['lookup'], files: [] },
        ],
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
  value.d1 = {
    CONTROL_DB: { id: 'control-id', name: `authrim-${env}-control` },
    LOOKUP_DB: { id: 'lookup-id', name: `authrim-${env}-lookup` },
  };
  value.r2 = {
    MIGRATION_RELEASES: {
      name: `authrim-${env}-migration-releases`,
    },
  };
  await writeFile(lockPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeDraftManifest(version: string): Promise<void> {
  const migrationsDir = join(tempDir!, 'migrations');
  await mkdir(migrationsDir, { recursive: true });
  await writeFile(
    join(migrationsDir, 'release-manifest.draft.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        productVersion: version,
        streams: [
          { id: 'd1-core', dialect: 'sqlite', logicalRoles: ['core'], files: [] },
          { id: 'd1-pii', dialect: 'sqlite', logicalRoles: ['pii'], files: [] },
          { id: 'd1-admin', dialect: 'sqlite', logicalRoles: ['admin'], files: [] },
          { id: 'd1-control', dialect: 'sqlite', logicalRoles: ['control'], files: [] },
          { id: 'd1-lookup', dialect: 'sqlite', logicalRoles: ['lookup'], files: [] },
        ],
      },
      null,
      2
    )}\n`
  );
}

async function enableTenantD1WithoutBootstrapResources(env: string): Promise<void> {
  const configPath = join(tempDir!, '.authrim', env, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8'));
  config.profiles.defaults.storage = 'builtin:storage:tenant-d1';
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const releasesDir = join(tempDir!, 'migrations', 'releases');
  await mkdir(releasesDir, { recursive: true });
  await writeFile(
    join(releasesDir, '0.2.0.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        productVersion: '0.2.0',
        streams: [
          { id: 'd1-core', dialect: 'sqlite', logicalRoles: ['core'], files: [] },
          { id: 'd1-pii', dialect: 'sqlite', logicalRoles: ['pii'], files: [] },
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

    buildApiPackagesMock.mockReset();
    deployAllMock.mockReset();
    deployAllUiWorkersMock.mockReset();
    deployWorkerMock.mockReset();
    deployUiWorkerBindingTargetsMock.mockReset();
    resolveExistingWorkerComponentsMock.mockReset();
    resolveMissingUiWorkerBindingTargetsMock.mockReset();
    loadDeploySecretsFromKeysMock.mockReset();
    getWorkersSubdomainMock.mockReset();
    saveMasterWranglerConfigsMock.mockReset();
    syncWranglerConfigsMock.mockReset();
    buildWorkerHttpReadinessTargetsMock.mockReset();
    waitForRouterWorkerReadyMock.mockReset();
    waitForWorkerDeploymentsReadyMock.mockReset();
    waitForWorkerHttpReadyMock.mockReset();
    configureDownstreamIntrospectionDeploymentMock.mockReset();
    ensureInitialTenantD1ResourcesMock.mockReset();
    ensureInitialTenantRegionShardConfigMock.mockReset();
    publishInitialTenantD1RuntimeSnapshotMock.mockReset();
    ensureInitialNotificationProviderConfigurationMock.mockReset();
    runMigrationsForEnvironmentMock.mockReset();
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
    recordInitialBootstrapWorkerEvidenceMock.mockReset();
    waitForInitialBootstrapHandoffMock.mockReset();
    discoverExternalCapabilitiesMock.mockReset();
    registerExternalCapabilitiesMock.mockReset();
    publishDynamicPluginWorkerBundlesMock.mockReset();
    queryD1RowsMock.mockReset();

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
    queryD1RowsMock.mockResolvedValue([]);
    saveMasterWranglerConfigsMock.mockResolvedValue({ success: true, errors: [] });
    syncWranglerConfigsMock.mockResolvedValue({ success: true, errors: [], synced: ['ar-auth'] });
    buildWorkerHttpReadinessTargetsMock.mockReturnValue([]);
    waitForRouterWorkerReadyMock.mockResolvedValue({ ready: true });
    waitForWorkerDeploymentsReadyMock.mockResolvedValue({ ready: true });
    waitForWorkerHttpReadyMock.mockResolvedValue({ ready: true });
    configureDownstreamIntrospectionDeploymentMock.mockResolvedValue({ success: true });
    ensureInitialTenantD1ResourcesMock.mockResolvedValue({ success: true, skipped: true });
    ensureInitialTenantRegionShardConfigMock.mockResolvedValue({ created: true, config: {} });
    publishInitialTenantD1RuntimeSnapshotMock.mockResolvedValue({ success: true, skipped: true });
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
    runMigrationsForEnvironmentMock.mockResolvedValue({
      success: true,
      core: { success: true, appliedCount: 0, skippedCount: 0 },
      pii: { success: true, appliedCount: 0, skippedCount: 0 },
      admin: { success: true, appliedCount: 0, skippedCount: 0 },
    });
    applyReleaseSchemaUpdatePlanMock.mockResolvedValue({
      success: true,
      results: [
        {
          targetId: 'd1:control-id:d1-control',
          success: true,
          appliedCount: 0,
          skippedCount: 0,
        },
        {
          targetId: 'd1:lookup-id:d1-lookup',
          success: true,
          appliedCount: 0,
          skippedCount: 0,
        },
      ],
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
      artifact: { releaseId: '0.2.0', streamIds: ['d1-core', 'd1-pii', 'd1-lookup'] },
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
    recordInitialBootstrapWorkerEvidenceMock.mockResolvedValue({
      workerCount: 1,
      controlDeploymentId: 'deployment-control',
      controlVersionId: 'version-control',
    });
    waitForInitialBootstrapHandoffMock.mockResolvedValue({ state: 'accepted', acceptedAt: 100 });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
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
    };

    expect(statusBody.status).toBe('deploying');
    expect(statusBody.progress).toContain('Starting worker update for environment: test');
    expect(statusBody.progress).toContain('Deploying ar-auth...');

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
    await enableTenantD1WithoutBootstrapResources(env);

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
        { binding: 'TDB_DEFAULT_BOOTSTRAP_CORE', reason: 'missing_binding' },
        { binding: 'TDB_USERS_BOOTSTRAP_CORE', reason: 'missing_binding' },
        { binding: 'TDB_PII_BOOTSTRAP_PII', reason: 'missing_binding' },
      ],
    });
    expect(ensureInitialTenantD1ResourcesMock).not.toHaveBeenCalled();
    expect(deployAllMock).not.toHaveBeenCalled();
  });

  it('does not let a request body spoof a Tenant D1 topology operation', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await enableTenantD1WithoutBootstrapResources(env);

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
    expect(ensureInitialTenantD1ResourcesMock).not.toHaveBeenCalled();
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
      body: JSON.stringify({ env, rootDir: tempDir }),
    });

    await buildStarted.promise;
    const operationLockPath = join(tempDir!, '.authrim', env, 'lock.json.operation-lock');
    await expect(readFile(operationLockPath, 'utf-8')).resolves.toContain('web-initial-deploy');

    finishBuild.resolve();
    expect((await deployment).status).toBe(500);
    await expect(readFile(operationLockPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('completes a schema-first initial Web deployment without Login UI or Admin UI', async () => {
    const env = 'headless';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);
    await writeDraftManifest('0.2.0');
    await rm(join(tempDir!, 'packages'), { recursive: true, force: true });
    const configPath = join(tempDir!, '.authrim', env, 'config.json');
    const config = createDefaultConfig(env);
    config.components.loginUi = false;
    config.components.adminUi = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const events: string[] = [];
    applyReleaseSchemaUpdatePlanMock.mockImplementation(async () => {
      events.push('schema');
      return {
        success: true,
        results: [
          {
            targetId: 'd1:control-id:d1-control',
            success: true,
            appliedCount: 0,
            skippedCount: 0,
          },
          {
            targetId: 'd1:lookup-id:d1-lookup',
            success: true,
            appliedCount: 0,
            skippedCount: 0,
          },
        ],
      };
    });
    resolveMissingUiWorkerBindingTargetsMock.mockResolvedValue({
      loginUi: false,
      adminUi: false,
    });
    publishAndActivateMigrationReleaseMock.mockImplementation(async () => {
      events.push('release');
      return {
        artifact: { releaseId: '0.2.0', streamIds: ['d1-core', 'd1-pii', 'd1-lookup'] },
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
    deployAllMock.mockImplementation(async (_options, components) => {
      events.push('workers');
      const results = components.map((component) => ({
        component,
        workerName: `${env}-${component}`,
        version: '0.2.0',
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
    waitForInitialBootstrapHandoffMock.mockImplementation(async () => {
      events.push('acceptance');
      return { state: 'accepted', acceptedAt: 100 };
    });

    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request('/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body: JSON.stringify({
        env,
        rootDir: tempDir,
        skipBuild: true,
        runMigrations: true,
      }),
    });

    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({ success: true });
    expect(events).toEqual([
      'schema',
      'release',
      'inventory',
      'topology',
      'workers',
      'evidence',
      'acceptance',
    ]);
    expect(applyReleaseSchemaUpdatePlanMock).toHaveBeenCalledOnce();
    expect(runMigrationsForEnvironmentMock).not.toHaveBeenCalled();
    expect(resolveMissingUiWorkerBindingTargetsMock).toHaveBeenCalledWith(expect.any(Object), {
      loginUi: false,
      adminUi: false,
    });
    expect(deployUiWorkerBindingTargetsMock).not.toHaveBeenCalled();
    expect(deployAllUiWorkersMock).not.toHaveBeenCalled();
    expect(ensureAdminUiBffMachineAccessInD1Mock).not.toHaveBeenCalled();
    expect(prepareAdminUiBffDeploymentMock).not.toHaveBeenCalled();
    expect(recordInitialBootstrapWorkerEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: env,
        controlDatabaseName: `authrim-${env}-control`,
      })
    );

    const lock = JSON.parse(await readFile(join(tempDir!, '.authrim', env, 'lock.json'), 'utf-8'));
    expect(lock.productVersion).toBe('0.2.0');
    expect(lock.releaseUpdate?.phase).toBe('verified');
    expect(lock.workers['ar-login-ui']).toBeUndefined();
    expect(lock.workers['ar-admin-ui']).toBeUndefined();
  });

  it('rejects a caller-selected subset before initial deployment build work', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await markEnvironmentProvisioned(env);

    const token = generateSessionToken();
    const app = createApiRoutes();
    const cachedConfig = createDefaultConfig(env);
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
      body: JSON.stringify({ env, rootDir: tempDir, components: ['ar-auth'] }),
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
      ['/migrations/run', { env, rootDir: tempDir }],
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

  it('configures Service Site fallback and deploys ar-router', async () => {
    const env = 'test';
    await writeEnvironment(env);
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
      expect.objectContaining({ env, dryRun: false })
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
      })
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
      }),
      { loginUi: true, adminUi: true }
    );
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
    await expect(response.json()).resolves.toMatchObject({ success: true, component: 'ar-auth' });
    expect(loadDeploySecretsFromKeysMock).toHaveBeenCalledWith(expect.any(String), ['ar-auth']);
    expect(deployAllMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        rootDir: tempDir,
        deploymentStrategy: 'auto',
        existingComponents: expect.arrayContaining(['ar-auth']),
        secrets: expect.objectContaining({
          FLOW_RUNTIME_HMAC_SECRET: 'flow-runtime-secret',
          PLUGIN_ENCRYPTION_KEY: 'plugin-encryption-key',
        }),
      }),
      ['ar-auth']
    );
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
