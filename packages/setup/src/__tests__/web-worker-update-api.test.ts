import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';

const buildApiPackagesMock = vi.hoisted(() => vi.fn());
const deployAllMock = vi.hoisted(() => vi.fn());
const deployWorkerMock = vi.hoisted(() => vi.fn());
const deployUiWorkerBindingTargetsMock = vi.hoisted(() => vi.fn());
const uploadSecretsMock = vi.hoisted(() => vi.fn());
const getWorkersSubdomainMock = vi.hoisted(() => vi.fn());
const saveMasterWranglerConfigsMock = vi.hoisted(() => vi.fn());
const syncWranglerConfigsMock = vi.hoisted(() => vi.fn());
const buildWorkerHttpReadinessTargetsMock = vi.hoisted(() => vi.fn());
const waitForRouterWorkerReadyMock = vi.hoisted(() => vi.fn());
const waitForWorkerDeploymentsReadyMock = vi.hoisted(() => vi.fn());
const waitForWorkerHttpReadyMock = vi.hoisted(() => vi.fn());
const configureDownstreamIntrospectionDeploymentMock = vi.hoisted(() => vi.fn());

vi.mock('../core/deploy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/deploy.js')>();
  return {
    ...actual,
    buildApiPackages: buildApiPackagesMock,
    deployAll: deployAllMock,
    deployWorker: deployWorkerMock,
    deployUiWorkerBindingTargets: deployUiWorkerBindingTargetsMock,
    uploadSecrets: uploadSecretsMock,
  };
});

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    getWorkersSubdomain: getWorkersSubdomainMock,
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
  await writeFile(join(envDir, 'config.json'), JSON.stringify(createDefaultConfig(env), null, 2));
  await writeFile(
    join(envDir, 'lock.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
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

describe('setup web worker update API', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-web-worker-update-api-')));
    process.chdir(tempDir);

    buildApiPackagesMock.mockReset();
    deployAllMock.mockReset();
    deployWorkerMock.mockReset();
    deployUiWorkerBindingTargetsMock.mockReset();
    uploadSecretsMock.mockReset();
    getWorkersSubdomainMock.mockReset();
    saveMasterWranglerConfigsMock.mockReset();
    syncWranglerConfigsMock.mockReset();
    buildWorkerHttpReadinessTargetsMock.mockReset();
    waitForRouterWorkerReadyMock.mockReset();
    waitForWorkerDeploymentsReadyMock.mockReset();
    waitForWorkerHttpReadyMock.mockReset();
    configureDownstreamIntrospectionDeploymentMock.mockReset();

    buildApiPackagesMock.mockResolvedValue({ success: true });
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
    uploadSecretsMock.mockResolvedValue({ success: true, errors: [] });
    getWorkersSubdomainMock.mockResolvedValue('example-subdomain');
    saveMasterWranglerConfigsMock.mockResolvedValue({ success: true, errors: [] });
    syncWranglerConfigsMock.mockResolvedValue({ success: true, errors: [], synced: ['ar-auth'] });
    buildWorkerHttpReadinessTargetsMock.mockReturnValue([]);
    waitForRouterWorkerReadyMock.mockResolvedValue({ ready: true });
    waitForWorkerDeploymentsReadyMock.mockResolvedValue({ ready: true });
    waitForWorkerHttpReadyMock.mockResolvedValue({ ready: true });
    configureDownstreamIntrospectionDeploymentMock.mockResolvedValue({ success: true });
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

    expect(response.status).toBe(200);
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

  it('uploads supplemental API worker secrets before bulk worker updates', async () => {
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
    expect(uploadSecretsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        FLOW_RUNTIME_HMAC_SECRET: expect.any(String),
        PLUGIN_ENCRYPTION_KEY: expect.any(String),
      }),
      expect.objectContaining({ env, rootDir: tempDir }),
      expect.arrayContaining(['ar-auth'])
    );
  });

  it('uploads supplemental API worker secrets before single worker deploys', async () => {
    const env = 'test';
    await writeEnvironment(env);
    await saveKeysToDirectory(generateAllSecrets('test-key'), { keysBaseDir: tempDir!, env });

    deployWorkerMock.mockResolvedValue({
      success: true,
      component: 'ar-auth',
      workerName: 'test-ar-auth',
      version: '0.2.0',
      deployedAt: '2026-06-18T00:00:00.000Z',
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
    expect(uploadSecretsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        FLOW_RUNTIME_HMAC_SECRET: expect.any(String),
        PLUGIN_ENCRYPTION_KEY: expect.any(String),
      }),
      expect.objectContaining({ env, rootDir: tempDir }),
      ['ar-auth']
    );
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
