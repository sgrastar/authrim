import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import {
  buildApiPackages,
  buildUiWorkerBuildEnv,
  deployAll,
  deployUiWorkerComponent,
  deployUiWorkerBindingTargets,
  deployWorker,
  hasBlockingDeploymentFailures,
} from '../core/deploy.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const tempDirs: string[] = [];

function createTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'authrim-deploy-test-'));
  tempDirs.push(dir);
  return dir;
}

function createWorkerPackage(rootDir: string, component: string, version: string): void {
  const packageDir = join(rootDir, 'packages', component);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'wrangler.toml'), `name = "test-${component}"\n`);
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: `@authrim/${component}`,
      version,
    })
  );
}

function createUiPackage(rootDir: string, component: string): void {
  const packageDir = join(rootDir, 'packages', component);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: `@authrim/${component}`,
      version: '1.0.0',
      scripts: { build: 'echo build' },
    })
  );
}

beforeEach(() => {
  vi.mocked(execa).mockReset();
  vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);
});

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('buildUiWorkerBuildEnv', () => {
  it('strips leaked PUBLIC_* values and injects the runtime API base URL', () => {
    const result = buildUiWorkerBuildEnv(
      {
        KEEP_ME: '1',
        PUBLIC_API_BASE_URL: 'https://stale.example.com',
        PUBLIC_AUTHRIM_ISSUER: 'https://stale-issuer.example.com',
      },
      {
        apiBaseUrl: 'https://api.example.com',
        preferPackageEnv: false,
      }
    );

    expect(result.KEEP_ME).toBe('1');
    expect(result.PUBLIC_API_BASE_URL).toBe('https://api.example.com');
    expect(result.PUBLIC_AUTHRIM_ISSUER).toBeUndefined();
  });

  it('prefers package-local env files over shell PUBLIC_* variables', () => {
    const result = buildUiWorkerBuildEnv(
      {
        PUBLIC_API_BASE_URL: 'https://shell.example.com',
        PUBLIC_LOGIN_UI_CLIENT_ID: 'client-from-shell',
      },
      {
        apiBaseUrl: 'https://api.example.com',
        preferPackageEnv: true,
      }
    );

    expect(result.PUBLIC_API_BASE_URL).toBeUndefined();
    expect(result.PUBLIC_LOGIN_UI_CLIENT_ID).toBeUndefined();
  });
});

describe('hasBlockingDeploymentFailures', () => {
  const successfulState = {
    workerFailedCount: 0,
    migrationsSuccess: true,
    initialTenantSuccess: true,
    initialAdminRolesSuccess: true,
    setupMachineAccessSuccess: true,
    adminUiBffMachineAccessSuccess: true,
    defaultCanonicalCatalogSeedSuccess: true,
    runtimeProfileSeedSuccess: true,
    uiWorkersSuccess: true,
  };

  it('accepts a fully successful deployment', () => {
    expect(hasBlockingDeploymentFailures(successfulState)).toBe(false);
  });

  it('rejects a deployment with any Worker failure', () => {
    expect(
      hasBlockingDeploymentFailures({
        ...successfulState,
        workerFailedCount: 1,
      })
    ).toBe(true);
  });

  it.each([
    'migrationsSuccess',
    'initialTenantSuccess',
    'initialAdminRolesSuccess',
    'setupMachineAccessSuccess',
    'adminUiBffMachineAccessSuccess',
    'defaultCanonicalCatalogSeedSuccess',
    'runtimeProfileSeedSuccess',
    'uiWorkersSuccess',
  ] as const)('rejects a deployment when %s is false', (key) => {
    expect(
      hasBlockingDeploymentFailures({
        ...successfulState,
        [key]: false,
      })
    ).toBe(true);
  });
});

describe('buildApiPackages', () => {
  it('builds only the requested worker component when components are specified', async () => {
    const rootDir = createTempRoot();
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    const progressMessages: string[] = [];
    const result = await buildApiPackages({
      rootDir,
      components: ['ar-auth'],
      onProgress: (message) => progressMessages.push(message),
    });

    expect(result.success).toBe(true);
    expect(progressMessages).toContain('Building ar-auth...');
    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'turbo', 'run', 'build', '--filter=@authrim/ar-auth'],
      expect.objectContaining({ cwd: rootDir })
    );
  });
});

describe('deployWorker', () => {
  it('rejects invalid environment names before attempting deployment', async () => {
    const result = await deployWorker('ar-auth', {
      env: 'Prod!',
      rootDir: '/tmp/does-not-matter',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid environment name');
  });

  it('supports dry runs when the package and wrangler config are present', async () => {
    const rootDir = createTempRoot();
    const packageDir = join(rootDir, 'packages', 'ar-auth');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'wrangler.toml'), 'name = "test-ar-auth"\n');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@authrim/ar-auth',
        version: '9.9.9',
      })
    );

    const progressMessages: string[] = [];
    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      dryRun: true,
      onProgress: (message) => progressMessages.push(message),
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe('9.9.9');
    expect(progressMessages).toContain('[1/3] Deploying test-ar-auth...');
    expect(progressMessages).toContain('  [DRY RUN] Would deploy ar-auth with --env test');
  });
});

describe('deployUiWorkerComponent', () => {
  it('uploads Admin UI BFF machine credential secrets after Admin UI deploy', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-admin-ui');
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    const result = await deployUiWorkerComponent('ar-admin-ui', {
      env: 'test',
      rootDir,
      adminUiBffSecrets: {
        ADMIN_UI_BFF_CLIENT_ID: 'authrim-admin-ui-bff',
        ADMIN_UI_BFF_KEY_ID: 'bff-key-1',
        ADMIN_UI_BFF_PRIVATE_KEY_PEM:
          '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        ADMIN_UI_BFF_SCOPES: 'admin-ui:proxy',
      },
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      'pnpm',
      [
        'exec',
        'wrangler',
        'secret',
        'put',
        'ADMIN_UI_BFF_PRIVATE_KEY_PEM',
        '--name',
        'test-ar-admin-ui',
      ],
      expect.objectContaining({
        cwd: join(rootDir, 'packages', 'ar-admin-ui'),
        input: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      })
    );
    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'wrangler', 'secret', 'put', 'ADMIN_UI_BFF_SCOPES', '--name', 'test-ar-admin-ui'],
      expect.objectContaining({
        cwd: join(rootDir, 'packages', 'ar-admin-ui'),
        input: 'admin-ui:proxy',
      })
    );
  });

  it('retries Admin UI BFF secret upload before failing the UI deploy', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-admin-ui');
    const successResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>;

    vi.mocked(execa)
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'fetch failed',
      } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(successResult);

    const progressMessages: string[] = [];
    const result = await deployUiWorkerComponent('ar-admin-ui', {
      env: 'test',
      rootDir,
      retryDelayMs: 1,
      onProgress: (message) => progressMessages.push(message),
      adminUiBffSecrets: {
        ADMIN_UI_BFF_CLIENT_ID: 'authrim-admin-ui-bff',
        ADMIN_UI_BFF_KEY_ID: 'bff-key-1',
        ADMIN_UI_BFF_PRIVATE_KEY_PEM:
          '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        ADMIN_UI_BFF_SCOPES: 'admin-ui:proxy',
      },
    });

    expect(result.success).toBe(true);
    expect(
      vi
        .mocked(execa)
        .mock.calls.filter(([, args]) => args?.includes('ADMIN_UI_BFF_PRIVATE_KEY_PEM'))
    ).toHaveLength(2);
    expect(progressMessages).toContain('  ✗ Secret upload attempt 1 failed: fetch failed');
    expect(progressMessages).toContain('  ✓ ADMIN_UI_BFF_PRIVATE_KEY_PEM uploaded');
  });
});

describe('deployUiWorkerBindingTargets', () => {
  it('pre-deploys UI Workers without service bindings or custom routes before router deploy', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    createUiPackage(rootDir, 'ar-admin-ui');
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    } as Awaited<ReturnType<typeof execa>>);

    const result = await deployUiWorkerBindingTargets(
      {
        env: 'test',
        rootDir,
        apiBaseUrl: 'https://test.example.com',
      },
      {
        loginUi: true,
        adminUi: true,
      }
    );

    expect(result.failedCount).toBe(0);
    const loginWrangler = readFileSync(
      join(rootDir, 'packages', 'ar-login-ui', 'wrangler.toml'),
      'utf-8'
    );
    const adminWrangler = readFileSync(
      join(rootDir, 'packages', 'ar-admin-ui', 'wrangler.toml'),
      'utf-8'
    );

    expect(loginWrangler).toContain('name = "test-ar-login-ui"');
    expect(loginWrangler).toContain('workers_dev = true');
    expect(loginWrangler).not.toContain('[[services]]');
    expect(loginWrangler).not.toContain('[[routes]]');
    expect(adminWrangler).toContain('name = "test-ar-admin-ui"');
    expect(adminWrangler).toContain('workers_dev = true');
    expect(adminWrangler).not.toContain('[[services]]');
    expect(adminWrangler).not.toContain('[[routes]]');
  });
});

describe('deployAll', () => {
  it('waits between successful worker deployments when a delay is configured', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    createWorkerPackage(rootDir, 'ar-token', '1.0.0');

    const progressMessages: string[] = [];
    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        interDeploymentDelayMs: 100,
        onProgress: (message) => progressMessages.push(message),
      },
      ['ar-auth', 'ar-token']
    );

    expect(summary.successCount).toBe(2);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
    expect(progressMessages).toContain('  ⏳ Waiting 0.1s before deploying the next worker...');
  });

  it('stops all later deployment levels after a critical Worker fails', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-lib-core', '1.0.0');
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    vi.mocked(execa).mockRejectedValue(new Error('invalid D1 binding'));

    const result = await deployAll(
      {
        env: 'test',
        rootDir,
        maxRetries: 1,
        retryDelayMs: 1,
      },
      ['ar-lib-core', 'ar-auth']
    );

    expect(result.failedCount).toBe(1);
    expect(result.results.map((item) => item.component)).toEqual(['ar-lib-core']);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });
});
