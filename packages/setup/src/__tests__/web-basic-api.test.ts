import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { acquireEnvironmentOperationLock } from '../core/lock.js';
import { createApiRoutes, generateSessionToken, getSessionToken } from '../web/api.js';

const cloudflareMocks = vi.hoisted(() => ({
  detectEnvironments: vi.fn(),
  hasControlManagedResourcesForEnvironment: vi.fn(),
}));

vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    detectEnvironments: cloudflareMocks.detectEnvironments,
    hasControlManagedResourcesForEnvironment:
      cloudflareMocks.hasControlManagedResourcesForEnvironment,
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

async function writeDeployedLock(env: string): Promise<void> {
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
        d1: {},
        kv: {},
        workers: {},
      },
      null,
      2
    )}\n`
  );
}

describe('setup web basic API contracts', () => {
  beforeEach(async () => {
    cloudflareMocks.detectEnvironments.mockReset().mockResolvedValue([]);
    cloudflareMocks.hasControlManagedResourcesForEnvironment.mockReset().mockResolvedValue(false);
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-web-basic-')));
    process.chdir(root);
  });

  afterEach(async () => {
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
      ['/provision', {}],
      ['/wrangler/generate', {}],
      ['/deploy', {}],
      ['/reset', {}],
      ['/admin/setup', {}],
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
    ] as const) {
      const missing = await app.request(path, post(path, body));
      expect(missing.status, path).toBe(401);
      const stale = await app.request(path, post(path, body, first));
      expect(stale.status, path).toBe(401);
    }
  });

  it('rejects deletion when the environment has no lock file', async () => {
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

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('environment_operation_in_progress'),
      });
      await expect(readFile(lockPath, 'utf-8')).resolves.toContain('"env": "prod"');
    } finally {
      await heldOperation.release();
    }
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

  it('generates environment-scoped keys and reports their availability', async () => {
    const token = generateSessionToken();
    const app = createApiRoutes();
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
    });
    await expect((await app.request('/keys/check/prod')).json()).resolves.toMatchObject({
      exists: true,
      env: 'prod',
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
});
