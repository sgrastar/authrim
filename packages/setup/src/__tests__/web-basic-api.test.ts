import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { EnvironmentInventoryUnavailableError } from '../core/cloudflare.js';
import { acquireDeployConfigLock, acquireEnvironmentOperationLock } from '../core/lock.js';
import { createApiRoutes, generateSessionToken, getSessionToken } from '../web/api.js';

const cloudflareMocks = vi.hoisted(() => ({
  confirmEnvironmentObservedForDeletion: vi.fn(),
  detectEnvironments: vi.fn(),
  deleteEnvironment: vi.fn(),
  getAccountId: vi.fn(),
  getCloudflareApiToken: vi.fn(),
  listQueues: vi.fn(),
}));
const runReleaseUpdateCliMock = vi.hoisted(() => vi.fn());
const completeInitialSetupMock = vi.hoisted(() => vi.fn());
const cleanupSetupManagedControlTokensMock = vi.hoisted(() => vi.fn());
const tokenBootstrapMocks = vi.hoisted(() => ({
  detectCloudflareTokenOwnership: vi.fn(),
  cleanupCloudflareBootstrapToken: vi.fn(),
  selectPreferredCloudflareTokenOwnership: vi.fn(),
}));

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    confirmEnvironmentObservedForDeletion: cloudflareMocks.confirmEnvironmentObservedForDeletion,
    detectEnvironments: cloudflareMocks.detectEnvironments,
    deleteEnvironment: cloudflareMocks.deleteEnvironment,
    getAccountId: cloudflareMocks.getAccountId,
    getCloudflareApiToken: cloudflareMocks.getCloudflareApiToken,
    listQueues: cloudflareMocks.listQueues,
  };
});

vi.mock('../web/release-update-runner.js', () => ({
  runReleaseUpdateCli: runReleaseUpdateCliMock,
}));

vi.mock('../core/admin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/admin.js')>();
  return {
    ...actual,
    completeInitialSetup: completeInitialSetupMock,
  };
});

vi.mock('../core/control-token-environment-cleanup.js', () => ({
  cleanupSetupManagedControlTokens: cleanupSetupManagedControlTokensMock,
}));

vi.mock('../core/cloudflare-control-token-bootstrap.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/cloudflare-control-token-bootstrap.js')>();
  return {
    ...actual,
    detectCloudflareTokenOwnership: tokenBootstrapMocks.detectCloudflareTokenOwnership,
    cleanupCloudflareBootstrapToken: tokenBootstrapMocks.cleanupCloudflareBootstrapToken,
    selectPreferredCloudflareTokenOwnership:
      tokenBootstrapMocks.selectPreferredCloudflareTokenOwnership,
  };
});

const originalCwd = process.cwd();
let root: string;

function post(path: string, body: unknown, token?: string): globalThis.RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Session-Token': token } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function writeDeployedLock(
  env: string,
  resources: {
    d1?: Record<string, { id: string; name: string }>;
    queues?: Record<string, { id: string; name: string }>;
    pages?: Record<string, { name: string; id: string; createdOn: string }>;
    workers?: Record<
      string,
      {
        name: string;
        deployedAt?: string;
        cloudflareVersionId?: string;
        cloudflareScriptTag?: string;
      }
    >;
    workerScriptOwnership?: Record<string, Record<string, unknown>>;
  } = {}
): Promise<void> {
  const envDir = join(root, '.authrim', env);
  await mkdir(envDir, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'authrim-test', version: '0.4.0' }, null, 2)}\n`
  );
  await writeFile(
    join(envDir, 'lock.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        productVersion: '0.4.0',
        env,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        d1: resources.d1 ?? {},
        kv: {},
        queues: resources.queues,
        pages: resources.pages,
        workers: resources.workers ?? {},
        workerScriptOwnership: resources.workerScriptOwnership,
      },
      null,
      2
    )}\n`
  );
}

describe('setup web basic API contracts', () => {
  beforeEach(async () => {
    cloudflareMocks.detectEnvironments.mockReset().mockResolvedValue([]);
    cloudflareMocks.confirmEnvironmentObservedForDeletion.mockReset().mockResolvedValue(true);
    cloudflareMocks.getAccountId.mockReset().mockResolvedValue('98edc9b77724418e61ae577980a7369b');
    cloudflareMocks.getCloudflareApiToken
      .mockReset()
      .mockResolvedValue({ token: 'oauth-token', source: 'oauth' });
    cloudflareMocks.listQueues.mockReset().mockResolvedValue([]);
    cloudflareMocks.deleteEnvironment.mockReset().mockResolvedValue({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      errors: [],
    });
    runReleaseUpdateCliMock.mockReset();
    completeInitialSetupMock.mockReset().mockResolvedValue({
      success: false,
      error: 'Setup key material is unavailable',
    });
    cleanupSetupManagedControlTokensMock.mockReset().mockResolvedValue({
      status: 'completed',
      revokedTokenIds: [],
      alreadyAbsentTokenIds: [],
    });
    tokenBootstrapMocks.detectCloudflareTokenOwnership.mockReset().mockResolvedValue('account');
    tokenBootstrapMocks.cleanupCloudflareBootstrapToken
      .mockReset()
      .mockResolvedValue({ revoked: true });
    tokenBootstrapMocks.selectPreferredCloudflareTokenOwnership
      .mockReset()
      .mockResolvedValue('account');
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-web-basic-')));
    process.chdir(root);
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  it('uses a fresh high-entropy token and protects every mutating setup route', async () => {
    const first = generateSessionToken();
    const second = generateSessionToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(getSessionToken()).toBe(second);
    const app = createApiRoutes();

    for (const [path, body] of [
      ['/config', {}],
      ['/config/default', {}],
      ['/keys/generate', {}],
      ['/email/configure', {}],
      ['/service-site/configure', {}],
      ['/env/email/cloudflare/enable', {}],
      ['/provision', {}],
      ['/wrangler/generate', {}],
      ['/deploy', {}],
      ['/reset', {}],
      ['/admin/setup', {}],
      ['/admin/generate-token', {}],
      ['/cloudflare/check-zone', {}],
      ['/cloudflare/control-token-template', {}],
      ['/control/pending-operations/execute', {}],
      ['/control/automatic-provisioning/prepare', {}],
      ['/control/automatic-provisioning/cancel-pending', {}],
      ['/control/automatic-provisioning/complete', {}],
      ['/control/automatic-provisioning/cleanup-bootstrap', {}],
      ['/control/capacity/preview', {}],
      ['/control/capacity/request', {}],
      ['/r2/prod/provision', {}],
      ['/environments/prod/delete', {}],
      ['/migrations/apply', {}],
      ['/migrations/run', {}],
      ['/update/release', {}],
      ['/update/workers', {}],
      ['/deploy/component/ar-auth', {}],
    ] as const) {
      const missing = await app.request(path, post(path, body));
      expect(missing.status, path).toBe(401);
      const stale = await app.request(path, post(path, body, first));
      expect(stale.status, path).toBe(401);
    }
  });

  it('reports an available product release for detected environments', async () => {
    await writeDeployedLock('prod');
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.5.0' }, null, 2)}\n`
    );
    cloudflareMocks.detectEnvironments.mockResolvedValue([
      { env: 'prod', workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
    ]);

    const response = await createApiRoutes().request('/environments');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      targetVersion: '0.5.0',
      environments: [
        {
          env: 'prod',
          release: {
            status: 'update_available',
            currentVersion: '0.4.0',
            targetVersion: '0.5.0',
            canUpdate: true,
          },
        },
      ],
    });
  });

  it('lists a locally preserved environment even when Cloudflare inventory is empty', async () => {
    await writeDeployedLock('retry-env', {
      workers: { 'ar-auth': { name: 'retry-env-ar-auth' } },
    });
    cloudflareMocks.detectEnvironments.mockResolvedValue([]);

    const response = await createApiRoutes().request('/environments');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      environments: [
        {
          env: 'retry-env',
          workers: [{ name: 'retry-env-ar-auth' }],
          release: { currentVersion: '0.4.0' },
        },
      ],
    });
  });

  it('runs the canonical release update from the authenticated Web action', async () => {
    await writeDeployedLock('prod');
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.5.0' }, null, 2)}\n`
    );
    runReleaseUpdateCliMock.mockImplementation(async ({ env, onProgress }) => {
      onProgress?.('Database schemas applied');
      const lockPath = join(root, '.authrim', env, 'lock.json');
      const current = JSON.parse(await readFile(lockPath, 'utf-8'));
      await writeFile(
        lockPath,
        `${JSON.stringify(
          {
            ...current,
            productVersion: '0.5.0',
            releaseUpdate: {
              targetVersion: '0.5.0',
              previousProductVersion: '0.4.0',
              phase: 'verified',
              manifestChecksum: 'a'.repeat(64),
              startedAt: '2026-08-16T00:00:00.000Z',
              updatedAt: '2026-08-16T00:01:00.000Z',
            },
          },
          null,
          2
        )}\n`
      );
      return { success: true, exitCode: 0 };
    });
    const token = generateSessionToken();
    const response = await createApiRoutes().request(
      '/update/release',
      post('/update/release', { env: 'prod' }, token)
    );

    expect(response.status).toBe(200);
    expect(runReleaseUpdateCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ env: 'prod', cwd: root, onProgress: expect.any(Function) })
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      release: { status: 'up_to_date', targetVersion: '0.5.0' },
      progress: expect.arrayContaining(['Database schemas applied']),
    });
  });

  it('returns 202 while a durable Control handoff continues', async () => {
    await writeDeployedLock('prod');
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.5.0' }, null, 2)}\n`
    );
    runReleaseUpdateCliMock.mockImplementation(async ({ env }) => {
      const lockPath = join(root, '.authrim', env, 'lock.json');
      const current = JSON.parse(await readFile(lockPath, 'utf-8'));
      await writeFile(
        lockPath,
        `${JSON.stringify(
          {
            ...current,
            releaseUpdate: {
              targetVersion: '0.5.0',
              previousProductVersion: '0.4.0',
              phase: 'control_handoff',
              manifestChecksum: 'a'.repeat(64),
              controlOperationId: `op_release_rollout_${'b'.repeat(32)}`,
              startedAt: '2026-08-16T00:00:00.000Z',
              updatedAt: '2026-08-16T00:01:00.000Z',
            },
          },
          null,
          2
        )}\n`
      );
      return { success: true, exitCode: 0 };
    });

    const response = await createApiRoutes().request(
      '/update/release',
      post('/update/release', { env: 'prod' }, generateSessionToken())
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      inProgress: true,
      release: { status: 'resume_available', phase: 'control_handoff' },
    });
  });

  it('passes the explicit database-only mode and accepts its verified checkpoint', async () => {
    await writeDeployedLock('prod');
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'authrim-test', version: '0.5.0' }, null, 2)}\n`
    );
    runReleaseUpdateCliMock.mockImplementation(async ({ env }) => {
      const lockPath = join(root, '.authrim', env, 'lock.json');
      const current = JSON.parse(await readFile(lockPath, 'utf-8'));
      await writeFile(
        lockPath,
        `${JSON.stringify(
          {
            ...current,
            releaseUpdate: {
              targetVersion: '0.5.0',
              previousProductVersion: '0.4.0',
              phase: 'database_only_verified',
              manifestChecksum: 'a'.repeat(64),
              startedAt: '2026-08-16T00:00:00.000Z',
              updatedAt: '2026-08-16T00:01:00.000Z',
            },
          },
          null,
          2
        )}\n`
      );
      return { success: true, exitCode: 0 };
    });

    const response = await createApiRoutes().request(
      '/update/release',
      post('/update/release', { env: 'prod', databaseOnly: true }, generateSessionToken())
    );

    expect(response.status).toBe(200);
    expect(runReleaseUpdateCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ databaseOnly: true })
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      release: { status: 'update_available', currentVersion: '0.4.0' },
    });
  });

  it('rejects deletion when the environment has no lock file', async () => {
    cloudflareMocks.confirmEnvironmentObservedForDeletion.mockResolvedValueOnce(false);
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request(
      '/environments/missing/delete',
      post('/environments/missing/delete', {}, token)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'The environment has not been provisioned.',
    });
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: 'error',
      error: 'The environment has not been provisioned.',
      operationProgress: { operation: 'delete', current: 0, total: 0 },
    });
  });

  it('deletes config, intent, pending secrets, and keys from pre-resource provisioning', async () => {
    const env = 'partial';
    const envDir = join(root, '.authrim', env);
    const keysDir = join(root, '.authrim-keys', env);
    await mkdir(envDir, { recursive: true });
    await mkdir(keysDir, { recursive: true });
    await writeFile(
      join(envDir, 'config.json'),
      `${JSON.stringify({
        keys: {
          storageType: 'external',
          secretsPath: `${keysDir}/`,
        },
      })}\n`
    );
    await chmod(join(envDir, 'config.json'), 0o600);
    await writeFile(join(envDir, 'provisioning-intent.json'), '{}\n');
    await writeFile(join(envDir, 'pending-email-secrets.json'), '{"token":"secret"}\n');
    await writeFile(join(keysDir, 'private.pem'), 'secret-key');
    cloudflareMocks.confirmEnvironmentObservedForDeletion.mockResolvedValueOnce(false);

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      environmentDeleted: true,
    });
    expect(cloudflareMocks.confirmEnvironmentObservedForDeletion).toHaveBeenCalledOnce();
    expect(cloudflareMocks.deleteEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ env, environmentKnownLocally: true })
    );
    await expect(readFile(join(envDir, 'config.json'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(keysDir, 'private.pem'), 'utf-8')).rejects.toThrow();
  });

  it('repairs a legacy 0644 environment config before deletion', async () => {
    const env = 'legacy-config-mode';
    const envDir = join(root, '.authrim', env);
    await mkdir(envDir, { recursive: true });
    const configPath = join(envDir, 'config.json');
    await writeFile(configPath, `${JSON.stringify({ environment: { prefix: env } })}\n`);
    await chmod(configPath, 0o644);
    cloudflareMocks.confirmEnvironmentObservedForDeletion.mockResolvedValueOnce(false);

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );
    const result = await response.json();

    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({
      success: true,
      environmentDeleted: true,
    });
    expect(cloudflareMocks.deleteEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ env, environmentKnownLocally: true })
    );
  });

  it('does not let deletion race another environment mutation', async () => {
    const env = 'prod';
    await writeDeployedLock(env);
    const lockPath = join(root, '.authrim', env, 'lock.json');
    const heldOperation = await acquireEnvironmentOperationLock(lockPath, 'test-held-operation');
    try {
      const token = generateSessionToken();
      const app = createApiRoutes();
      const response = await app.request(
        `/environments/${env}/delete`,
        post(`/environments/${env}/delete`, {}, token)
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        errorCode: 'setup_operation_in_progress',
        error: expect.stringContaining('Another setup operation is already in progress'),
      });
      await expect(readFile(lockPath, 'utf-8')).resolves.toContain('"env": "prod"');
    } finally {
      await heldOperation.release();
    }
  });

  it('does not let web deletion race package wrangler changes from another environment', async () => {
    const env = 'prod';
    await writeDeployedLock(env);
    const heldDeployConfig = await acquireDeployConfigLock({
      baseDir: root,
      env: 'other',
      operation: 'test-held-deploy-config',
    });
    try {
      const response = await createApiRoutes().request(
        `/environments/${env}/delete`,
        post(`/environments/${env}/delete`, {}, generateSessionToken())
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: 'Another setup operation is already in progress. Wait for it to finish and retry.',
      });
      expect(cloudflareMocks.deleteEnvironment).not.toHaveBeenCalled();
      await expect(readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')).resolves.toContain(
        '"env": "prod"'
      );
    } finally {
      await heldDeployConfig.release();
    }
  });

  it('passes lock-recorded immutable storage identities through the shared safe deletion core', async () => {
    const env = 'prod';
    await writeDeployedLock(env, {
      d1: {
        CONTROL_DB: { id: 'control-id', name: 'prod-authrim-control-db' },
        BOOTSTRAP_DB: {
          id: 'bootstrap-id',
          name: 'prod-authrim-tenant-default-bootstrap-db',
        },
      },
      queues: {
        AUDIT_QUEUE: { id: 'queue-id', name: 'prod-audit-queue' },
      },
      workers: {
        'ar-auth': { name: 'prod-ar-auth', cloudflareScriptTag: 'auth-tag' },
        'ar-management': {
          name: 'prod-ar-management',
          cloudflareScriptTag: 'management-tag',
        },
      },
    });
    const token = generateSessionToken();
    const app = createApiRoutes();
    cloudflareMocks.deleteEnvironment.mockImplementationOnce(async (options) => {
      await options.beforeD1Deletion?.({
        observedD1Resources: [{ id: 'control-id', name: 'prod-authrim-control-db' }],
      });
      return {
        success: true,
        completion: 'complete',
        environmentEmpty: true,
        deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
        manualR2: [],
        errors: [],
      };
    });

    const response = await app.request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, token)
    );

    expect(response.status).toBe(200);
    expect(cloudflareMocks.deleteEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        knownWorkerResources: [
          { name: 'prod-ar-auth', cloudflareScriptTag: 'auth-tag' },
          { name: 'prod-ar-management', cloudflareScriptTag: 'management-tag' },
        ],
        knownD1Resources: [
          { id: 'control-id', name: 'prod-authrim-control-db' },
          { id: 'bootstrap-id', name: 'prod-authrim-tenant-default-bootstrap-db' },
        ],
        knownKVResources: [],
        knownQueueResources: [{ id: 'queue-id', name: 'prod-audit-queue' }],
      })
    );
    expect(cleanupSetupManagedControlTokensMock).toHaveBeenCalledWith({
      baseDir: root,
      environment: env,
      controlDatabaseIdentifier: 'control-id',
    });
  });

  it('atomically upgrades legacy Queue name sentinels before confirmed deletion', async () => {
    const env = 'conformance';
    const accountId = '98edc9b77724418e61ae577980a7369b';
    const queueName = `${env}-audit-queue`;
    const providerId = 'queue-provider-id';
    await writeDeployedLock(env, {
      queues: {
        AUDIT_QUEUE: { id: queueName, name: queueName },
      },
    });
    const config = createDefaultConfig(env);
    config.cloudflare = { accountId };
    config.keys.secretsPath = `${join(root, '.authrim-keys', env)}/`;
    await writeFile(
      join(root, '.authrim', env, 'config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 }
    );
    cloudflareMocks.listQueues.mockResolvedValueOnce([{ id: providerId, name: queueName }]);
    cloudflareMocks.deleteEnvironment.mockImplementationOnce(async (options) => {
      expect(options.knownQueueResources).toEqual([{ id: providerId, name: queueName }]);
      const persisted = JSON.parse(
        await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')
      ) as { queues: Record<string, { id: string; name: string }> };
      expect(persisted.queues.AUDIT_QUEUE).toEqual({ id: providerId, name: queueName });
      return {
        success: true,
        completion: 'complete',
        environmentEmpty: true,
        deleted: { workers: [], d1: [], kv: [], queues: [queueName], r2: [], pages: [] },
        manualR2: [],
        errors: [],
      };
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(cloudflareMocks.getAccountId).toHaveBeenCalledOnce();
    expect(cloudflareMocks.listQueues).toHaveBeenCalledWith({
      strictOutput: true,
      requireIds: true,
    });
  });

  it('persists a verified legacy Worker script tag before deletion continues', async () => {
    const env = 'prod';
    const versionId = '11111111-1111-4111-8111-111111111111';
    await writeDeployedLock(env, {
      workers: {
        'ar-auth': { name: 'prod-ar-auth', cloudflareVersionId: versionId },
      },
    });
    cloudflareMocks.deleteEnvironment.mockImplementationOnce(async (options) => {
      await options.onWorkerIdentityBackfill?.([
        {
          name: 'prod-ar-auth',
          cloudflareVersionId: versionId,
          cloudflareScriptTag: 'verified-auth-tag',
        },
      ]);
      return {
        success: true,
        completion: 'complete',
        environmentEmpty: false,
        retryable: false,
        postDeleteVerification: 'not_required',
        deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [], dns: [] },
        manualR2: [],
        manualDns: [],
        errors: [],
      };
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(200);
    const persisted = JSON.parse(
      await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')
    ) as { workers: Record<string, { cloudflareScriptTag?: string }> };
    expect(persisted.workers['ar-auth']?.cloudflareScriptTag).toBe('verified-auth-tag');
  });

  it('uses a provisional script ownership checkpoint for verified deletion recovery', async () => {
    const env = 'prod';
    await writeDeployedLock(env, {
      workerScriptOwnership: {
        'ar-auth': {
          name: 'prod-ar-auth',
          cloudflareScriptTag: 'provisional-auth-tag',
          state: 'provisional',
          updatedAt: '2026-08-31T00:00:00.000Z',
        },
      },
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      progress: expect.arrayContaining([
        expect.stringContaining('unfinished Worker ownership checkpoint'),
      ]),
    });
    expect(cloudflareMocks.deleteEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        knownWorkerResources: [
          { name: 'prod-ar-auth', cloudflareScriptTag: 'provisional-auth-tag' },
        ],
      })
    );
  });

  it('returns a retryable inventory error without deleting or cleaning local state', async () => {
    const env = 'prod';
    await writeDeployedLock(env, {
      workers: { 'ar-auth': { name: 'prod-ar-auth' } },
    });
    cloudflareMocks.deleteEnvironment.mockRejectedValueOnce(
      new EnvironmentInventoryUnavailableError(
        'Workers',
        new Error('Cloudflare API returned HTTP 503')
      )
    );

    const app = createApiRoutes();
    const response = await app.request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'environment_inventory_unavailable',
      error: expect.stringContaining('No resources were deleted'),
      errors: [expect.stringContaining('No resources were deleted')],
      progress: expect.arrayContaining([expect.stringContaining('No resources were deleted')]),
      operationProgress: { operation: 'delete', current: 0, total: 0 },
    });
    await expect(readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')).resolves.toContain(
      'prod-ar-auth'
    );
  });

  it('returns the retryable inventory error when no local lock exists', async () => {
    const env = 'prod';
    cloudflareMocks.confirmEnvironmentObservedForDeletion.mockRejectedValueOnce(
      new EnvironmentInventoryUnavailableError(
        'Workers',
        new Error('Cloudflare API returned HTTP 503')
      )
    );

    const app = createApiRoutes();
    const response = await app.request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'environment_inventory_unavailable',
      errors: [expect.stringContaining('No resources were deleted')],
    });
    expect(cloudflareMocks.deleteEnvironment).not.toHaveBeenCalled();
  });

  it('publishes structured resource progress while deleting an environment', async () => {
    const env = 'prod';
    await writeDeployedLock(env);
    let finishDeletion: (() => void) | undefined;
    const deletionPaused = new Promise<void>((resolve) => {
      finishDeletion = resolve;
    });
    cloudflareMocks.deleteEnvironment.mockImplementationOnce(
      async (options: {
        onResourceProgress?: (progress: { current: number; total: number }) => void;
      }) => {
        options.onResourceProgress?.({ current: 0, total: 2 });
        options.onResourceProgress?.({ current: 1, total: 2 });
        await deletionPaused;
        options.onResourceProgress?.({ current: 2, total: 2 });
        return {
          success: true,
          completion: 'complete',
          environmentEmpty: true,
          deleted: {
            workers: ['prod-ar-auth'],
            d1: ['prod-authrim-core-db'],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          },
          manualR2: [],
          errors: [],
        };
      }
    );

    const app = createApiRoutes();
    const responsePromise = app.request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );
    await vi.waitFor(async () => {
      await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
        operationProgress: { operation: 'delete', current: 1, total: 2 },
      });
    });
    finishDeletion?.();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      operationProgress: { operation: 'delete', current: 2, total: 2 },
    });
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      operationProgress: { operation: 'delete', current: 2, total: 2 },
    });
  });

  it('reports large R2 cleanup as a manual action instead of an API error', async () => {
    const env = 'prod';
    await writeDeployedLock(env);
    cloudflareMocks.deleteEnvironment.mockResolvedValueOnce({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: false,
      deleted: {
        workers: ['prod-ar-auth'],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [],
      },
      manualR2: [
        {
          bucketName: 'prod-diagnostic-logs',
          objectCount: 5_214,
          dashboardUrl: 'https://dash.cloudflare.com/account/r2/bucket',
        },
      ],
      errors: [],
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      completion: 'manual_action_required',
      errors: [],
      manualR2: [
        {
          bucketName: 'prod-diagnostic-logs',
          objectCount: 5_214,
          dashboardUrl: 'https://dash.cloudflare.com/account/r2/bucket',
        },
      ],
    });
    await expect((await createApiRoutes().request('/deploy/status')).json()).resolves.toMatchObject(
      {
        status: 'complete',
        error: null,
      }
    );
  });

  it('returns a Cloudflare DNS dashboard link for deletion DNS manual actions', async () => {
    const env = 'prod';
    const accountId = '98edc9b77724418e61ae577980a7369b';
    await writeDeployedLock(env);
    const config = createDefaultConfig(env);
    config.cloudflare = { accountId };
    config.tenant.multiTenant = true;
    config.tenant.baseDomain = 'login.example.com';
    await writeFile(
      join(root, '.authrim', env, 'config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 }
    );
    cloudflareMocks.deleteEnvironment.mockResolvedValueOnce({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: true,
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      manualDns: [
        {
          role: 'tenant_wildcard',
          name: '(tenant_wildcard)',
          reason: 'dns_ownership_evidence_missing',
        },
      ],
      errors: [],
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      completion: 'manual_action_required',
      environmentDeleted: true,
      manualR2: [],
      manualDns: [
        {
          role: 'tenant_wildcard',
          dashboardUrl: `https://dash.cloudflare.com/${accountId}/example.com/dns/records`,
        },
      ],
    });
    await expect(readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')).rejects.toMatchObject(
      { code: 'ENOENT' }
    );
  });

  it('returns actionable token review links and still removes an empty local environment', async () => {
    const env = 'prod';
    const accountId = '98edc9b77724418e61ae577980a7369b';
    await writeDeployedLock(env);
    const config = createDefaultConfig(env);
    config.cloudflare = { accountId };
    await writeFile(
      join(root, '.authrim', env, 'config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 }
    );
    cloudflareMocks.deleteEnvironment.mockResolvedValueOnce({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: true,
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      manualDns: [],
      manualControlTokens: [
        {
          reason:
            'control_token_cleanup_checkpoint_required_for_missing_control_database_manual_recovery_required',
        },
      ],
      errors: [],
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      completion: 'manual_action_required',
      environmentDeleted: true,
      manualControlTokens: [
        {
          accountTokensDashboardUrl: 'https://dash.cloudflare.com/?to=/:account/api-tokens',
          userTokensDashboardUrl: 'https://dash.cloudflare.com/profile/api-tokens',
        },
      ],
    });
    expect(body.manualControlTokens[0].expectedTokenNames).toHaveLength(5);
    await expect(readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')).rejects.toMatchObject(
      { code: 'ENOENT' }
    );
  });

  it('returns an error and preserves local state when Cloudflare deletion is incomplete', async () => {
    const env = 'prod';
    await writeDeployedLock(env, {
      workers: {
        'ar-auth': { name: 'prod-ar-auth' },
        'ar-token': { name: 'prod-ar-token' },
      },
    });
    const lockPath = join(root, '.authrim', env, 'lock.json');
    cloudflareMocks.deleteEnvironment.mockResolvedValueOnce({
      success: false,
      error: 'Failed to delete Worker: prod-ar-auth',
      completion: 'failed',
      environmentEmpty: false,
      deleted: {
        workers: ['prod-ar-auth'],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [],
      },
      manualR2: [],
      errors: ['Failed to delete Worker: prod-ar-auth'],
    });

    const app = createApiRoutes();
    const response = await app.request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      completion: 'failed',
      errors: ['Failed to delete Worker: prod-ar-auth'],
      progress: expect.arrayContaining([
        '⚠️ Local environment state preserved for deletion retry and diagnosis',
      ]),
    });
    const persistedLock = JSON.parse(await readFile(lockPath, 'utf-8')) as {
      env: string;
      workers: Record<string, { name: string }>;
    };
    expect(persistedLock.env).toBe('prod');
    expect(persistedLock.workers).toEqual({ 'ar-token': { name: 'prod-ar-token' } });
  });

  it('returns a retryable response and preserves local state when post-delete readback fails', async () => {
    const env = 'prod';
    await writeDeployedLock(env, {
      workers: { 'ar-auth': { name: 'prod-ar-auth' } },
    });
    const lockPath = join(root, '.authrim', env, 'lock.json');
    cloudflareMocks.deleteEnvironment.mockResolvedValueOnce({
      success: false,
      completion: 'failed',
      environmentEmpty: false,
      retryable: true,
      postDeleteVerification: 'inventory_unavailable',
      deleted: {
        workers: [],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [],
      },
      manualR2: [],
      errors: ['Post-delete Cloudflare inventory verification was unavailable; retry deletion.'],
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, {}, generateSessionToken())
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      retryable: true,
      postDeleteVerification: 'inventory_unavailable',
      environmentDeleted: false,
    });
    await expect(readFile(lockPath, 'utf-8')).resolves.toContain('prod-ar-auth');
  });

  it('preserves local inventory after a successful partial resource deletion', async () => {
    const env = 'prod';
    await writeDeployedLock(env, {
      d1: { CORE_DB: { id: 'core-id', name: 'prod-authrim-core-db' } },
      workers: {
        'ar-auth': { name: 'prod-ar-auth' },
        'ar-token': { name: 'prod-ar-token' },
      },
    });
    const lockPath = join(root, '.authrim', env, 'lock.json');
    cloudflareMocks.deleteEnvironment.mockResolvedValueOnce({
      success: true,
      completion: 'complete',
      environmentEmpty: false,
      deleted: {
        workers: ['prod-ar-auth'],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [],
      },
      manualR2: [],
      errors: [],
    });
    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(
        `/environments/${env}/delete`,
        {
          deleteWorkers: true,
          deleteD1: false,
          deleteKV: false,
          deleteQueues: false,
          deleteR2: false,
          deletePages: false,
        },
        generateSessionToken()
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      environmentDeleted: false,
      progress: expect.arrayContaining([
        'Local environment state preserved for resource types not selected',
      ]),
    });
    const persistedLock = JSON.parse(await readFile(lockPath, 'utf-8')) as {
      env: string;
      d1: Record<string, { name: string }>;
      workers: Record<string, { name: string }>;
    };
    expect(persistedLock).toMatchObject({
      env: 'prod',
      d1: { CORE_DB: { name: 'prod-authrim-core-db' } },
      workers: { 'ar-token': { name: 'prod-ar-token' } },
    });
    expect(persistedLock.workers).not.toHaveProperty('ar-auth');
  });

  it('keeps lock-recorded legacy Pages projects inside the strict final deletion boundary', async () => {
    const env = 'prod';
    const page = {
      name: 'prod-ar-admin-ui',
      id: 'pages-provider-id',
      createdOn: '2026-08-31T00:00:00.000Z',
    };
    await writeDeployedLock(env, { pages: { 'ar-admin-ui': page } });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(
        `/environments/${env}/delete`,
        {
          deleteWorkers: true,
          deleteD1: true,
          deleteKV: true,
          deleteQueues: true,
          deleteR2: true,
          deletePages: false,
          finalizeEnvironment: true,
        },
        generateSessionToken()
      )
    );

    expect(response.status).toBe(200);
    expect(cloudflareMocks.deleteEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        finalizeEnvironment: true,
        deletePages: true,
        knownPagesResources: [page],
      })
    );
  });

  it('removes a deleted legacy Pages identity from a lock preserved for partial deletion', async () => {
    const env = 'prod';
    const page = {
      name: 'prod-ar-admin-ui',
      id: 'pages-provider-id',
      createdOn: '2026-08-31T00:00:00.000Z',
    };
    await writeDeployedLock(env, { pages: { 'ar-admin-ui': page } });
    cloudflareMocks.deleteEnvironment.mockResolvedValueOnce({
      success: true,
      completion: 'complete',
      environmentEmpty: false,
      deleted: {
        workers: [],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [page.name],
      },
      manualR2: [],
      errors: [],
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(
        `/environments/${env}/delete`,
        {
          deleteWorkers: false,
          deleteD1: false,
          deleteKV: false,
          deleteQueues: false,
          deleteR2: false,
          deletePages: true,
        },
        generateSessionToken()
      )
    );

    expect(response.status).toBe(200);
    const persistedLock = JSON.parse(
      await readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')
    ) as { pages?: Record<string, unknown> };
    expect(persistedLock.pages).toEqual({});
  });

  it('removes local state when a partial retry deletes the final remaining resources', async () => {
    const env = 'prod';
    await writeDeployedLock(env, {
      workers: { 'ar-auth': { name: 'prod-ar-auth' } },
    });
    cloudflareMocks.deleteEnvironment.mockResolvedValueOnce({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      deleted: {
        workers: ['prod-ar-auth'],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [],
      },
      manualR2: [],
      errors: [],
    });

    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(
        `/environments/${env}/delete`,
        {
          deleteWorkers: true,
          deleteD1: false,
          deleteKV: false,
          deleteQueues: false,
          deleteR2: false,
          deletePages: false,
        },
        generateSessionToken()
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      environmentDeleted: true,
    });
    await expect(readFile(join(root, '.authrim', env, 'lock.json'), 'utf-8')).rejects.toMatchObject(
      {
        code: 'ENOENT',
      }
    );
  });

  it.each([
    [{ deleteWorkers: 'yes' }, 'Invalid environment deletion request'],
    [
      {
        deleteWorkers: false,
        deleteD1: false,
        deleteKV: false,
        deleteQueues: false,
        deleteR2: false,
        deletePages: false,
      },
      'Select at least one resource type to delete',
    ],
  ])('rejects an invalid environment deletion selection', async (body, expectedError) => {
    const env = 'prod';
    await writeDeployedLock(env);
    const response = await createApiRoutes().request(
      `/environments/${env}/delete`,
      post(`/environments/${env}/delete`, body, generateSessionToken())
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expectedError,
    });
    expect(cloudflareMocks.deleteEnvironment).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON in an environment deletion request as a client error', async () => {
    const env = 'prod';
    await writeDeployedLock(env);
    const response = await createApiRoutes().request(`/environments/${env}/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': generateSessionToken(),
      },
      body: '{',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid environment deletion request',
    });
    expect(cloudflareMocks.deleteEnvironment).not.toHaveBeenCalled();
  });

  it('returns read-only state, deploy status, and component inventory without a token', async () => {
    const app = createApiRoutes();
    await expect((await app.request('/state')).json()).resolves.toMatchObject({
      status: expect.any(String),
      progress: expect.any(Array),
    });
    await expect((await app.request('/deploy/status')).json()).resolves.toMatchObject({
      status: expect.any(String),
      results: expect.any(Array),
    });
    const components = (await (await app.request('/components')).json()) as {
      workers: string[];
      uiWorkers: string[];
      all: string[];
    };
    expect(components.all).toEqual([...components.workers, ...components.uiWorkers]);
    expect(components.workers).toContain('ar-auth');
  });

  it('creates a normalized default config and forces core optional services on', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request(
      '/config/default',
      post(
        '/config/default',
        {
          env: 'staging',
          apiDomain: 'api.example.com',
          loginUiDomain: 'login.example.com',
          adminUiDomain: 'admin.example.com',
          zoneId: 'zone-1',
          customDomainBinding: true,
          tenant: {
            mode: 'single',
            name: 'default',
            multiTenant: false,
            nakedDomain: false,
          },
          components: { saml: false, async: false, vc: false, bridge: false, policy: false },
        },
        token
      )
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      config: {
        environment: { prefix: 'staging' },
        profile: 'basic-op',
        components: { saml: true, async: true, vc: true, bridge: true, policy: true },
        urls: {
          api: { custom: 'https://api.example.com' },
          loginUi: { custom: 'https://login.example.com' },
          adminUi: { custom: 'https://admin.example.com' },
        },
      },
    });
  });

  it('rejects invalid default profiles', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const invalidProfile = await app.request(
      '/config/default',
      post('/config/default', { profiles: 'invalid' }, token)
    );
    expect(invalidProfile.status).toBe(400);
    await expect(invalidProfile.json()).resolves.toMatchObject({
      success: false,
      errors: expect.any(Array),
    });
  });

  it('validates a complete config, schema failures, domain conflicts, and malformed JSON', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const config = createDefaultConfig('prod');
    expect(
      (await app.request('/config/validate', post('/config/validate', config, token))).status
    ).toBe(200);
    const invalid = await app.request('/config/validate', post('/config/validate', {}, token));
    expect(await invalid.json()).toMatchObject({ valid: false, errors: expect.any(Array) });

    config.urls = {
      ...config.urls,
      loginUi: { ...config.urls?.loginUi, custom: 'ui.example.com' },
      adminUi: { ...config.urls?.adminUi, custom: 'ui.example.com' },
    } as never;
    const conflict = await app.request('/config/validate', post('/config/validate', config, token));
    expect(await conflict.json()).toMatchObject({ valid: false, errors: expect.any(Array) });

    const malformed = await app.request('/config/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ valid: false, error: 'Invalid JSON syntax' });
  });

  it('saves and reloads a valid environment config in the new structure', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const config = createDefaultConfig('prod');
    const saved = await app.request('/config', post('/config', config, token));
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ success: true, structure: 'new' });
    const loaded = await app.request('/config?env=prod');
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toMatchObject({
      exists: true,
      valid: true,
      structure: 'new',
      config: { environment: { prefix: 'prod' } },
    });
  });

  it('rejects provisioning an existing environment without changing its files', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const config = createDefaultConfig('prod');
    expect((await app.request('/config', post('/config', config, token))).status).toBe(200);
    await writeDeployedLock('prod');
    const lockPath = join(root, '.authrim', 'prod', 'lock.json');
    const configPath = join(root, '.authrim', 'prod', 'config.json');
    const lockBefore = await readFile(lockPath, 'utf-8');
    const configBefore = await readFile(configPath, 'utf-8');

    const response = await app.request(
      '/provision',
      post('/provision', { env: 'prod', createQueues: true, createR2: true }, token)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('already exists'),
    });
    expect(await readFile(lockPath, 'utf-8')).toBe(lockBefore);
    expect(await readFile(configPath, 'utf-8')).toBe(configBefore);
  });

  it('allows ordinary deployed config changes but rejects database topology changes', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const config = createDefaultConfig('prod');
    expect((await app.request('/config', post('/config', config, token))).status).toBe(200);
    await writeDeployedLock('prod');

    const ordinaryChange = structuredClone(config);
    ordinaryChange.components.saml = !ordinaryChange.components.saml;
    expect((await app.request('/config', post('/config', ordinaryChange, token))).status).toBe(200);

    const topologyChange = structuredClone(ordinaryChange);
    topologyChange.tenant.placementPolicy = 'shared_pool';
    const rejected = await app.request('/config', post('/config', topologyChange, token));
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('dedicated topology operation'),
    });
    const persisted = JSON.parse(
      await readFile(join(root, '.authrim', 'prod', 'config.json'), 'utf-8')
    );
    expect(persisted.tenant.placementPolicy).toBe('tenant_exclusive');
  });

  it('rejects config mutation while a release update is incomplete', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const config = createDefaultConfig('prod');
    expect((await app.request('/config', post('/config', config, token))).status).toBe(200);
    await writeDeployedLock('prod');
    const lockPath = join(root, '.authrim', 'prod', 'lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    lock.releaseUpdate = {
      targetVersion: '0.5.0',
      previousProductVersion: '0.4.0',
      phase: 'schema_applied',
      manifestChecksum: 'a'.repeat(64),
      startedAt: '2026-07-21T00:01:00.000Z',
      updatedAt: '2026-07-21T00:02:00.000Z',
      appliedTargets: [],
      manualTargets: [],
    };
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    config.components.saml = !config.components.saml;
    const response = await app.request('/config', post('/config', config, token));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('release update is incomplete'),
      requiredCommand: 'authrim-setup update --env prod',
    });
  });

  it('reports missing, malformed, and schema-invalid config files without leaking internals', async () => {
    const app = createApiRoutes();
    await expect((await app.request('/config?env=prod')).json()).resolves.toMatchObject({
      exists: false,
      config: null,
    });
    const dir = join(root, '.authrim', 'prod');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), '{');
    const malformed = await app.request('/config?env=prod');
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      exists: true,
      valid: false,
      error: 'Invalid JSON syntax',
    });
    await writeFile(join(dir, 'config.json'), JSON.stringify({ environment: {} }));
    await expect((await app.request('/config?env=prod')).json()).resolves.toMatchObject({
      exists: true,
      valid: false,
      errors: expect.any(Array),
    });
  });

  it('validates zone-check input before invoking Cloudflare and resets mutable state', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    for (const body of [
      {},
      { domain: 1 },
      { domain: '-invalid.example' },
      { domain: 'localhost' },
    ]) {
      const response = await app.request(
        '/cloudflare/check-zone',
        post('/cloudflare/check-zone', body, token)
      );
      expect(response.status).toBe(400);
    }
    const reset = await app.request('/reset', post('/reset', {}, token));
    expect(reset.status).toBe(200);
    await expect((await app.request('/state')).json()).resolves.toMatchObject({
      status: 'idle',
      config: null,
      progress: [],
      error: null,
    });
  });

  it('requires same-loopback origin for the Cloudflare token template flow', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const missingOrigin = await app.request(
      '/cloudflare/control-token-template',
      post('/cloudflare/control-token-template', { env: 'test' }, token)
    );
    expect(missingOrigin.status).toBe(403);
    const crossOrigin = await app.request('/cloudflare/control-token-template', {
      ...post('/cloudflare/control-token-template', { env: 'test' }, token),
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'https://attacker.example',
      },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('returns the next UTC End Date with the Web token template flow', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T23:59:59Z'));
    const token = generateSessionToken();
    const app = createApiRoutes();
    const config = createDefaultConfig('test');
    expect((await app.request('/config', post('/config', config, token))).status).toBe(200);

    const response = await app.request('/cloudflare/control-token-template', {
      ...post('/cloudflare/control-token-template', { env: 'test' }, token),
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      ownership: 'account',
      expiresOnDate: '2026-09-02',
      url: expect.stringContaining('dash.cloudflare.com'),
    });
  });

  it('requires same-loopback origin and strict input for Automatic provisioning completion', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const path = '/control/automatic-provisioning/complete';
    const missingOrigin = await app.request(
      path,
      post(
        path,
        { env: 'test', bootstrapToken: 'bootstrap-token-value-123', ownership: 'user' },
        token
      )
    );
    expect(missingOrigin.status).toBe(403);

    const malformed = await app.request(path, {
      ...post(path, { env: 'test', bootstrapToken: 'short', ownership: 'user' }, token),
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      success: false,
      error: 'Invalid bootstrap token input',
    });

    const cleanupPath = '/control/automatic-provisioning/cleanup-bootstrap';
    const cleanupMissingOrigin = await app.request(
      cleanupPath,
      post(
        cleanupPath,
        { env: 'test', bootstrapToken: 'bootstrap-token-value-123', ownership: 'user' },
        token
      )
    );
    expect(cleanupMissingOrigin.status).toBe(403);
    const malformedCleanup = await app.request(cleanupPath, {
      ...post(cleanupPath, { env: 'test', bootstrapToken: 'short', ownership: 'user' }, token),
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
    });
    expect(malformedCleanup.status).toBe(400);
    await expect(malformedCleanup.json()).resolves.toEqual({
      success: false,
      error: 'Invalid bootstrap cleanup input',
    });

    const cancelPath = '/control/automatic-provisioning/cancel-pending';
    const cancelMissingOrigin = await app.request(
      cancelPath,
      post(cancelPath, { env: 'test' }, token)
    );
    expect(cancelMissingOrigin.status).toBe(403);
    const malformedCancel = await app.request(cancelPath, {
      ...post(cancelPath, { env: 'test', unexpected: true }, token),
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        Origin: 'http://localhost',
      },
    });
    expect(malformedCancel.status).toBe(400);
    await expect(malformedCancel.json()).resolves.toEqual({
      success: false,
      error: 'Invalid Automatic provisioning request',
    });
  });

  it('rejects bootstrap cleanup behind an external environment lock before token API access', async () => {
    await writeDeployedLock('test');
    await writeFile(
      join(root, '.authrim', 'test', 'config.json'),
      `${JSON.stringify(createDefaultConfig('test'), null, 2)}\n`
    );
    const held = await acquireEnvironmentOperationLock(
      join(root, '.authrim', 'test', 'lock.json'),
      'external-deploy'
    );
    try {
      const session = generateSessionToken();
      const response = await createApiRoutes().request(
        '/control/automatic-provisioning/cleanup-bootstrap',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': session,
            Origin: 'http://localhost',
          },
          body: JSON.stringify({
            env: 'test',
            bootstrapToken: 'bootstrap-token-value-123',
            ownership: 'account',
          }),
        }
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        errorCode: 'setup_operation_in_progress',
      });
      expect(tokenBootstrapMocks.detectCloudflareTokenOwnership).not.toHaveBeenCalled();
      expect(tokenBootstrapMocks.cleanupCloudflareBootstrapToken).not.toHaveBeenCalled();
    } finally {
      await held.release();
    }
  });

  it('protects pending Control operation discovery with the setup session', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    expect((await app.request('/control/pending-operations')).status).toBe(401);
    const response = await app.request('/control/pending-operations', {
      headers: { 'X-Session-Token': token },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      operations: [],
      warnings: [],
    });
  });

  it('rejects invalid migration environment, role, and filenames before execution', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    for (const body of [
      { env: '../prod' },
      { env: 'prod', role: 'other' },
      { env: 'prod', filenames: '001.sql' },
      { env: 'prod', filenames: [1] },
      { env: 'prod', filenames: ['../001.sql'] },
      { env: 'prod', filenames: ['readme.txt'] },
    ]) {
      const response = await app.request(
        '/migrations/apply',
        post('/migrations/apply', body, token)
      );
      expect(response.status).toBe(400);
    }
    const missingEnv = await app.request('/migrations/run', post('/migrations/run', {}, token));
    expect(missingEnv.status).toBe(400);
  });

  it('validates email provider configuration before writing any secrets', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    for (const body of [
      {},
      { env: '../prod', provider: 'resend', fromAddress: 'admin@example.com' },
      { env: 'prod', provider: 'unknown', fromAddress: 'admin@example.com' },
      { env: 'prod', provider: 'resend', fromAddress: 'invalid' },
    ]) {
      const response = await app.request('/email/configure', post('/email/configure', body, token));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ success: false });
    }
    const missingResendKey = await app.request(
      '/email/configure',
      post(
        '/email/configure',
        { env: 'prod', provider: 'resend', fromAddress: 'admin@example.com' },
        token
      )
    );
    expect(missingResendKey.status).toBe(400);
    await expect(missingResendKey.json()).resolves.toMatchObject({
      error: expect.stringContaining('Resend API key is required'),
    });
  });

  it('validates service-site configuration and requires a worker when enabled', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    for (const body of [
      {},
      { env: 'prod', enabled: true, binding: 'lowercase', workerName: 'site' },
      { env: 'prod', enabled: true, binding: 'SERVICE_SITE', workerName: 'Invalid_Name' },
    ]) {
      expect(
        (await app.request('/service-site/configure', post('/service-site/configure', body, token)))
          .status
      ).toBe(400);
    }
    const missingWorker = await app.request(
      '/service-site/configure',
      post('/service-site/configure', { env: 'prod', enabled: true }, token)
    );
    expect(missingWorker.status).toBe(400);
    await expect(missingWorker.json()).resolves.toMatchObject({
      error: expect.stringContaining('Worker name is required'),
    });
  });

  it('validates admin setup and token-generation inputs without invoking Cloudflare', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const setup = await app.request('/admin/setup', post('/admin/setup', {}, token));
    expect(setup.status).toBe(400);
    await expect(setup.json()).resolves.toMatchObject({ error: 'env and baseUrl are required' });

    for (const id of ['short', 'g'.repeat(32)]) {
      const status = await app.request(`/admin/status/${id}`);
      expect(status.status).toBe(400);
      await expect(status.json()).resolves.toEqual({
        success: false,
        error: 'Invalid KV namespace ID',
      });
    }
    for (const body of [{}, { kvNamespaceId: 'a'.repeat(32) }]) {
      const generated = await app.request(
        '/admin/generate-token',
        post('/admin/generate-token', body, token)
      );
      expect(generated.status).toBe(400);
    }
  });

  it('validates environment and component names before update or deployment work', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    for (const env of ['..%2Fprod', 'UPPER', '-prod']) {
      const response = await app.request(`/update/compare/${env}`);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'Invalid environment name' });
    }
    const invalidEnv = await app.request(
      '/deploy/component/ar-auth',
      post('/deploy/component/ar-auth', { env: '../prod' }, token)
    );
    expect(invalidEnv.status).toBe(400);
    const invalidComponent = await app.request(
      '/deploy/component/not-a-component',
      post('/deploy/component/not-a-component', { env: 'prod', dryRun: true }, token)
    );
    expect(invalidComponent.status).toBe(400);
    await expect(invalidComponent.json()).resolves.toMatchObject({
      error: expect.stringContaining('Unknown component'),
    });
  });

  it('does not overwrite a progress log when operations start in the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-24T04:00:00.123Z'));
    const token = generateSessionToken();
    const app = createApiRoutes();

    const first = await app.request(
      '/deploy/component/not-a-component',
      post('/deploy/component/not-a-component', { env: 'prod', dryRun: true }, token)
    );
    expect(first.status).toBe(400);
    const firstStatus = await (await app.request('/deploy/status')).json();

    const second = await app.request(
      '/deploy/component/not-a-component',
      post('/deploy/component/not-a-component', { env: 'prod', dryRun: true }, token)
    );
    expect(second.status).toBe(400);
    const secondStatus = await (await app.request('/deploy/status')).json();

    expect(firstStatus.logPath).toMatch(/-update\.log$/u);
    expect(secondStatus.logPath).toMatch(/-update-1\.log$/u);
    expect(secondStatus.logPath).not.toBe(firstStatus.logPath);
    await expect(readFile(firstStatus.logPath, 'utf-8')).resolves.toContain(
      'Unknown component: not-a-component'
    );
    await expect(readFile(secondStatus.logPath, 'utf-8')).resolves.toContain(
      'Unknown component: not-a-component'
    );
  });

  it('generates environment-scoped keys and reports their availability', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const configured = await app.request(
      '/config/default',
      post('/config/default', { env: 'prod' }, token)
    );
    expect(configured.status).toBe(200);
    await expect((await app.request('/keys/check/prod')).json()).resolves.toMatchObject({
      exists: false,
      env: 'prod',
    });
    const generated = await app.request(
      '/keys/generate',
      post('/keys/generate', { env: 'prod', keyId: 'setup-key-1' }, token)
    );
    expect(generated.status).toBe(200);
    await expect(generated.json()).resolves.toMatchObject({
      success: true,
      keyId: 'setup-key-1',
      publicKeyJwk: { kid: 'setup-key-1' },
      keysPath: expect.stringContaining('.authrim-keys/prod'),
      replacedExistingKeys: false,
    });
    await expect((await app.request('/keys/check/prod')).json()).resolves.toMatchObject({
      exists: true,
      env: 'prod',
    });

    const regenerated = await app.request(
      '/keys/generate',
      post('/keys/generate', { env: 'prod', keyId: 'setup-key-2' }, token)
    );
    expect(regenerated.status).toBe(200);
    await expect(regenerated.json()).resolves.toMatchObject({
      success: true,
      keyId: 'setup-key-1',
      replacedExistingKeys: false,
      reusedExistingKeys: true,
    });
  });

  it('rejects initial key generation before overwriting an existing environment', async () => {
    const token = generateSessionToken();
    await writeDeployedLock('prod');
    const app = createApiRoutes();

    const response = await app.request(
      '/keys/generate',
      post('/keys/generate', { env: 'prod', keyId: 'replacement-key' }, token)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'environment_already_exists',
      requiredAction: 'finish_environment_deletion_or_choose_another_name',
    });
    await expect(
      readFile(join(root, '.authrim-keys', 'prod', 'metadata.json'), 'utf-8')
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('persists email bootstrap settings from in-memory setup state', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const defaultConfig = await app.request(
      '/config/default',
      post('/config/default', { env: 'prod' }, token)
    );
    expect(defaultConfig.status).toBe(200);

    const configured = await app.request(
      '/email/configure',
      post(
        '/email/configure',
        {
          env: 'prod',
          provider: 'resend',
          apiKey: 're_test_key',
          fromAddress: 'admin@example.com',
          fromName: ' Authrim Admin ',
        },
        token
      )
    );
    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toMatchObject({
      success: true,
      provider: 'resend',
      fromAddress: 'admin@example.com',
    });
    await expect((await app.request('/state')).json()).resolves.toMatchObject({
      config: {
        features: {
          email: {
            provider: 'resend',
            fromAddress: 'admin@example.com',
            fromName: 'Authrim Admin',
            configured: true,
          },
        },
      },
    });
  });

  it('validates R2 and migration status environment names before external calls', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    expect((await app.request('/r2/UPPER/status')).status).toBe(400);
    expect(
      (await app.request('/r2/UPPER/provision', post('/r2/UPPER/provision', {}, token))).status
    ).toBe(400);
    expect(
      (await app.request('/r2/prod/provision', post('/r2/prod/provision', {}, token))).status
    ).toBe(404);
    expect((await app.request('/migrations/status/UPPER')).status).toBe(400);
  });

  it('updates an existing config file with Cloudflare email settings', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const config = createDefaultConfig('prod');
    expect((await app.request('/config', post('/config', config, token))).status).toBe(200);

    const configured = await app.request(
      '/email/configure',
      post(
        '/email/configure',
        { env: 'prod', provider: 'cloudflare', fromAddress: 'noreply@example.com' },
        token
      )
    );
    expect(configured.status).toBe(200);
    const loaded = await app.request('/config');
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toMatchObject({
      valid: true,
      structure: 'new',
      config: {
        features: {
          email: {
            provider: 'cloudflare',
            fromAddress: 'noreply@example.com',
            configured: true,
          },
        },
      },
    });
  });

  it('reports missing environment artifacts for otherwise valid service-site requests', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request(
      '/service-site/configure',
      post(
        '/service-site/configure',
        {
          env: 'prod',
          enabled: false,
          binding: 'SERVICE_SITE',
          deployRouter: false,
        },
        token
      )
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Config file not found'),
      progress: expect.arrayContaining([
        expect.stringContaining('Configuring Service Site binding'),
      ]),
    });
  });

  it('returns a controlled setup failure when required admin key material is absent', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
    const response = await app.request(
      '/admin/setup',
      post('/admin/setup', { env: 'prod', baseUrl: 'https://prod-ar-router.example.test' }, token)
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.any(String),
    });
  });

  it('never publishes the temporary admin setup token through deployment status', async () => {
    await writeDeployedLock('prod');
    const temporaryToken = 'temporary-setup-token-that-must-not-leak';
    completeInitialSetupMock.mockResolvedValueOnce({
      success: true,
      setupUrl: `https://login.example.test/setup?token=${temporaryToken}`,
      expiresAt: '2026-08-24T04:00:00.000Z',
    });
    const token = generateSessionToken();
    const app = createApiRoutes();

    const response = await app.request(
      '/admin/setup',
      post('/admin/setup', { env: 'prod', baseUrl: 'https://prod-ar-router.example.test' }, token)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      setupUrl: expect.stringContaining(temporaryToken),
    });
    const status = await (await app.request('/deploy/status')).json();
    expect(JSON.stringify(status.progress)).not.toContain(temporaryToken);
    expect(status.progress).toContain('Setup token stored successfully');
  });
});
