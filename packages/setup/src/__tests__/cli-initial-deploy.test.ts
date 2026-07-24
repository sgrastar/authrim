import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { CORE_WORKER_COMPONENTS } from '../core/naming.js';

const mocks = vi.hoisted(() => ({
  buildApiPackages: vi.fn(),
  deployAll: vi.fn(),
  deployAllUiWorkers: vi.fn(),
  deployUiWorkerBindingTargets: vi.fn(),
  resolveExistingWorkerComponents: vi.fn(),
  resolveMissingUiWorkerBindingTargets: vi.fn(),
  isWranglerInstalled: vi.fn(),
  checkAuth: vi.fn(),
  getWorkersSubdomain: vi.fn(),
  runMigrationsForEnvironment: vi.fn(),
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
  saveMasterWranglerConfigs: vi.fn(),
  checkWranglerStatus: vi.fn(),
  syncWranglerConfigs: vi.fn(),
  waitForRouterWorkerReady: vi.fn(),
  waitForWorkerDeploymentsReady: vi.fn(),
  waitForWorkerHttpReady: vi.fn(),
  buildWorkerHttpReadinessTargets: vi.fn(),
  ensureInitialTenantD1Resources: vi.fn(),
  publishInitialTenantD1RuntimeSnapshot: vi.fn(),
  completeInitialSetup: vi.fn(),
  prepareAdminUiBffDeployment: vi.fn(),
  printCliCapabilitySummary: vi.fn(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => {
    const spinner = {
      text: '',
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      warn: vi.fn(),
    };
    spinner.start.mockReturnValue(spinner);
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

vi.mock('../core/worker-readiness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/worker-readiness.js')>();
  return {
    ...actual,
    waitForRouterWorkerReady: mocks.waitForRouterWorkerReady,
    waitForWorkerDeploymentsReady: mocks.waitForWorkerDeploymentsReady,
    waitForWorkerHttpReady: mocks.waitForWorkerHttpReady,
    buildWorkerHttpReadinessTargets: mocks.buildWorkerHttpReadinessTargets,
  };
});

vi.mock('../core/tenant-d1-bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/tenant-d1-bootstrap.js')>();
  return {
    ...actual,
    ensureInitialTenantD1Resources: mocks.ensureInitialTenantD1Resources,
    publishInitialTenantD1RuntimeSnapshot: mocks.publishInitialTenantD1RuntimeSnapshot,
  };
});

vi.mock('../core/admin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/admin.js')>();
  return { ...actual, completeInitialSetup: mocks.completeInitialSetup };
});

vi.mock('../core/admin-ui-bff-deployment.js', () => ({
  prepareAdminUiBffDeployment: mocks.prepareAdminUiBffDeployment,
}));

vi.mock('../cli/capability-summary.js', () => ({
  printCliCapabilitySummary: mocks.printCliCapabilitySummary,
}));

import { deployCommand } from '../cli/commands/deploy.js';

const originalCwd = process.cwd();
let root: string;

async function writeHeadlessEnvironment(env: string): Promise<void> {
  const config = createDefaultConfig(env);
  config.components.loginUi = false;
  config.components.adminUi = false;

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
        r2: {},
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
        ],
      },
      null,
      2
    )}\n`
  );
}

describe('CLI initial deployment', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-cli-initial-deploy-')));
    process.chdir(root);
    vi.clearAllMocks();

    mocks.isWranglerInstalled.mockResolvedValue(true);
    mocks.checkAuth.mockResolvedValue({ isLoggedIn: true, email: 'test@example.com' });
    mocks.getWorkersSubdomain.mockResolvedValue('example-subdomain');
    mocks.listD1Databases.mockResolvedValue([
      { uuid: 'core-id', name: 'headless-authrim-core-db' },
      { uuid: 'pii-id', name: 'headless-authrim-pii-db' },
      { uuid: 'admin-id', name: 'headless-authrim-admin-db' },
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
    mocks.saveMasterWranglerConfigs.mockResolvedValue({ success: true, errors: [], files: [] });
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
    mocks.ensureInitialTenantD1Resources.mockResolvedValue({ success: true, skipped: true });
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
    mocks.publishInitialTenantD1RuntimeSnapshot.mockResolvedValue({
      success: true,
      skipped: true,
    });
    mocks.completeInitialSetup.mockResolvedValue({ success: true, alreadyCompleted: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  it('applies schema before API Workers and keeps both UI Workers disabled', async () => {
    const env = 'headless';
    await writeHeadlessEnvironment(env);
    const events: string[] = [];
    mocks.runMigrationsForEnvironment.mockImplementation(async () => {
      events.push('schema');
      return {
        success: true,
        core: { success: true, appliedCount: 0, skippedCount: 0 },
        pii: { success: true, appliedCount: 0, skippedCount: 0 },
        admin: { success: true, appliedCount: 0, skippedCount: 0 },
      };
    });
    mocks.deployAll.mockImplementation(async (_options, components) => {
      events.push('workers');
      const results = (components ?? CORE_WORKER_COMPONENTS).map((component) => ({
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

    await deployCommand({
      env,
      source: root,
      skipBuild: true,
      skipSecrets: true,
      yes: true,
    });

    expect(events).toEqual(['schema', 'workers']);
    expect(mocks.runMigrationsForEnvironment).toHaveBeenCalledOnce();
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
});
