import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import {
  buildAndDeployAllSequentially,
  buildUiWorkerBuildEnv,
  deployAll,
  deployUiWorkerComponent,
  deployUiWorkerBindingTargets,
  deployWorker,
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
        interDeploymentDelayMs: 0,
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
});

describe('buildAndDeployAllSequentially', () => {
  it('builds and deploys each worker before moving to the next worker', async () => {
    const rootDir = createTempRoot();
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    createWorkerPackage(rootDir, 'ar-token', '1.0.0');

    const summary = await buildAndDeployAllSequentially(
      {
        env: 'test',
        rootDir,
        interDeploymentDelayMs: 0,
      },
      ['ar-auth', 'ar-token']
    );

    expect(summary.successCount).toBe(2);
    expect(vi.mocked(execa)).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['exec', 'turbo', 'run', 'build', '--filter=@authrim/ar-auth'],
      expect.objectContaining({ cwd: rootDir })
    );
    expect(vi.mocked(execa)).toHaveBeenNthCalledWith(
      3,
      'pnpm',
      ['exec', 'wrangler', 'deploy', '--env', 'test'],
      expect.objectContaining({ cwd: join(rootDir, 'packages', 'ar-auth') })
    );
    expect(vi.mocked(execa)).toHaveBeenNthCalledWith(
      5,
      'pnpm',
      ['exec', 'turbo', 'run', 'build', '--filter=@authrim/ar-token'],
      expect.objectContaining({ cwd: rootDir })
    );
    expect(vi.mocked(execa)).toHaveBeenNthCalledWith(
      6,
      'pnpm',
      ['exec', 'wrangler', 'deploy', '--env', 'test'],
      expect.objectContaining({ cwd: join(rootDir, 'packages', 'ar-token') })
    );
  });

  it('stops before deploy when a component build fails', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');

    vi.mocked(execa).mockResolvedValueOnce({} as Awaited<ReturnType<typeof execa>>);
    vi.mocked(execa).mockRejectedValueOnce(new Error('turbo failed'));

    const summary = await buildAndDeployAllSequentially(
      {
        env: 'test',
        rootDir,
        interDeploymentDelayMs: 0,
      },
      ['ar-auth']
    );

    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(1);
    expect(summary.results[0]?.error).toContain('Build failed: turbo failed');
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
  });
});
