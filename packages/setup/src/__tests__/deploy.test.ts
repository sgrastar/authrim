import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import {
  buildApiPackages,
  buildUiWorkerBuildEnv,
  assertLoginUiBuildClientId,
  cleanupLegacyStaticSecrets,
  deployAll,
  deployUiWorkerComponent,
  deployUiWorkerBindingTargets,
  deployWorker,
  deployWorkerGradually,
  findNodeEngineMismatches,
  hasBlockingDeploymentFailures,
  loadDeploySecretsFromKeys,
  nodeVersionSatisfiesEngine,
  resolveExistingWorkerComponents,
  type WorkerDeploymentLeaseCoordinator,
} from '../core/deploy.js';
import { CORE_WORKER_COMPONENTS } from '../core/naming.js';
import type { SetupWorkerDeploymentLease } from '../core/worker-deployment-lease.js';

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function successfulCommandResult(): Awaited<ReturnType<typeof execa>> {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
  } as Awaited<ReturnType<typeof execa>>;
}

function commandError(message: string): Error & { stderr: string; exitCode: number } {
  return Object.assign(new Error(message), {
    stderr: message,
    exitCode: 1,
  });
}

function expectOptimizedWorkerUpload(args: readonly string[]): void {
  expect(args.filter((argument) => argument === '--minify')).toHaveLength(1);
  expect(args.filter((argument) => argument === '--upload-source-maps')).toHaveLength(1);
}

function fakeDeploymentLeaseCoordinator(calls: string[]): WorkerDeploymentLeaseCoordinator {
  const nextLease = (
    lease: SetupWorkerDeploymentLease,
    changes: Partial<SetupWorkerDeploymentLease> = {}
  ): SetupWorkerDeploymentLease => ({ ...lease, ...changes });
  return {
    acquire: async ({ workerScriptName, expectedSourceVersionId }) => {
      calls.push(`acquire:${workerScriptName}:${expectedSourceVersionId}`);
      return {
        environmentId: 'test',
        workerScriptName,
        operationId: 'op-test-deploy',
        fencingToken: 1,
        leaseExpiresAt: 1_000,
        expectedSourceVersionId,
        mutationStarted: false,
      };
    },
    renew: async (lease) => {
      calls.push(`renew:${lease.workerScriptName}:${lease.fencingToken}`);
      return nextLease(lease, { fencingToken: lease.fencingToken + 1 });
    },
    assertCurrent: async (lease) => {
      calls.push(`assert:${lease.workerScriptName}:${lease.fencingToken}`);
    },
    markMutationStarted: async (lease, deploymentId) => {
      calls.push(`start:${lease.workerScriptName}:${deploymentId}`);
      return nextLease(lease, { mutationStarted: true });
    },
    release: async (lease) => {
      calls.push(`release:${lease.workerScriptName}:${lease.fencingToken}`);
    },
    complete: async (success, errorCode) => {
      calls.push(`complete:${success}:${errorCode ?? ''}`);
    },
  };
}

beforeEach(() => {
  vi.mocked(execa).mockReset();
  vi.mocked(execa).mockResolvedValue(successfulCommandResult());
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
  it('detects an incompatible Node.js engine before starting the build', async () => {
    const rootDir = createTempRoot();
    const packageDir = join(rootDir, 'packages', 'ar-agent-access');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: 'authrim', engines: { node: '>=22.0.0' } })
    );
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@authrim/ar-agent-access',
        engines: { node: '>=99.0.0' },
      })
    );

    const progressMessages: string[] = [];
    const result = await buildApiPackages({
      rootDir,
      components: ['ar-agent-access'],
      onProgress: (message) => progressMessages.push(message),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('@authrim/ar-agent-access');
    expect(result.error).toContain('>=99.0.0');
    expect(progressMessages).toContain('Checking Node.js version requirements...');
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
  });

  it('supports the Node.js engine range syntax used by workspace packages', () => {
    const rootDir = createTempRoot();
    const packageDir = join(rootDir, 'packages', 'ar-agent-access');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: 'authrim', engines: { node: '>=22.0.0' } })
    );
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@authrim/ar-agent-access',
        engines: { node: '^22.18.0 || >=24.11.0' },
      })
    );

    expect(nodeVersionSatisfiesEngine('22.17.0', '^22.18.0 || >=24.11.0')).toBe(false);
    expect(nodeVersionSatisfiesEngine('22.23.2', '^22.18.0 || >=24.11.0')).toBe(true);
    expect(nodeVersionSatisfiesEngine('24.11.1', '^22.18.0 || >=24.11.0')).toBe(true);
    expect(findNodeEngineMismatches(rootDir, undefined, '22.17.0')).toEqual([
      { packageName: '@authrim/ar-agent-access', requirement: '^22.18.0 || >=24.11.0' },
    ]);
  });

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

  it('passes only the Worker allow-list through a temporary secrets file and cleans it up', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    let secretFilePath: string | undefined;
    let uploadedSecrets: Record<string, string> | undefined;
    let secretFileMode: number | undefined;

    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const commandArgs = args ?? [];
      const secretsFileIndex = commandArgs.indexOf('--secrets-file');
      expect(secretsFileIndex).toBeGreaterThan(-1);
      secretFilePath = commandArgs[secretsFileIndex + 1];
      uploadedSecrets = JSON.parse(readFileSync(secretFilePath, 'utf-8')) as Record<string, string>;
      secretFileMode = statSync(secretFilePath).mode & 0o777;
      expect(commandArgs).not.toContain('flow-secret');
      expect(commandArgs).not.toContain('logging-secret');
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      secrets: {
        FLOW_RUNTIME_HMAC_SECRET: 'flow-secret',
        PLUGIN_ENCRYPTION_KEY: 'plugin-secret',
        LOGGING_CURSOR_HMAC_SECRET: 'logging-secret',
      },
    });

    expect(result.success).toBe(true);
    expect(uploadedSecrets).toEqual({
      FLOW_RUNTIME_HMAC_SECRET: 'flow-secret',
    });
    expect(secretFileMode).toBe(0o600);
    expect(secretFilePath).toBeDefined();
    expect(existsSync(secretFilePath!)).toBe(false);
    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining([
        'exec',
        'wrangler',
        'deploy',
        '--minify',
        '--upload-source-maps',
        '--config',
        'wrangler.toml',
        '--env',
        'test',
        '--secrets-file',
      ]),
      expect.objectContaining({ cwd: join(rootDir, 'packages', 'ar-auth') })
    );
  });

  it('records the exact Cloudflare version ID reported by a direct deployment', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const versionId = 'direct-version-1';

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      if ((args ?? []).includes('deploy')) {
        const outputDirectory = options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY;
        expect(typeof outputDirectory).toBe('string');
        writeFileSync(
          join(String(outputDirectory), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'deploy', version_id: versionId })}\n`
        );
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, cloudflareVersionId: versionId })
    );
  });

  it('retries transient Cloudflare 503 failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const sleep = vi.fn(async () => undefined);
    vi.mocked(execa)
      .mockRejectedValueOnce(commandError('503 Service Unavailable'))
      .mockResolvedValueOnce(successfulCommandResult());

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 3,
      retryDelayMs: 2,
      random: () => 0.5,
      sleep,
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry deterministic Cloudflare 400 failures', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const sleep = vi.fn(async () => undefined);
    vi.mocked(execa).mockRejectedValue(commandError('400 Invalid service binding'));

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 3,
      retryDelayMs: 1,
      sleep,
    });

    expect(result.success).toBe(false);
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses direct deploy for Workers that contain Durable Object migrations', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    writeFileSync(
      join(rootDir, 'packages', 'ar-auth', 'wrangler.toml'),
      'name = "test-ar-auth"\n\n[[migrations]]\ntag = "v1"\nnew_classes = ["Store"]\n'
    );

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-auth'],
    });

    expect(result.success).toBe(true);
    const wranglerArgs = vi.mocked(execa).mock.calls[0]?.[1] ?? [];
    expect(wranglerArgs).toContain('deploy');
    expect(wranglerArgs).not.toContain('versions');
  });
});

describe('loadDeploySecretsFromKeys', () => {
  it('loads secrets for missing dependency Workers during a fresh individual deploy', async () => {
    const keysDir = createTempRoot();
    writeFileSync(join(keysDir, 'object_encryption_root_key.txt'), 'core-secret');
    writeFileSync(join(keysDir, 'flow_runtime_hmac_secret.txt'), 'auth-secret');

    await expect(loadDeploySecretsFromKeys(keysDir, ['ar-auth'])).resolves.toMatchObject({
      OBJECT_ENCRYPTION_ROOT_KEY: 'core-secret',
      FLOW_RUNTIME_HMAC_SECRET: 'auth-secret',
    });
  });

  it('loads the same profile-contract secret for Management and VC deployment', async () => {
    const keysDir = createTempRoot();
    writeFileSync(join(keysDir, 'vc_profile_contract_hmac_secret.txt'), 'shared-contract-secret');
    writeFileSync(join(keysDir, 'vc_evidence_hmac_secret.txt'), 'evidence-secret');

    await expect(
      loadDeploySecretsFromKeys(keysDir, ['ar-management', 'ar-vc'])
    ).resolves.toMatchObject({
      VC_PROFILE_CONTRACT_HMAC_SECRET: 'shared-contract-secret',
      VC_EVIDENCE_HMAC_SECRET: 'evidence-secret',
    });
  });
});

describe('cleanupLegacyStaticSecrets', () => {
  it('deletes only retired secret names that still exist on successfully deployed workers', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      if (args.includes('list')) {
        if (args.includes('deployments')) {
          return {
            ...successfulCommandResult(),
            stdout: JSON.stringify([
              {
                id: 'cleanup-deployment',
                versions: [{ version_id: 'cleanup-v2', percentage: 100 }],
              },
            ]),
          } as Awaited<ReturnType<typeof execa>>;
        }
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            { name: 'ADMIN_API_SECRET', type: 'secret_text' },
            { name: 'KEY_MANAGER_SECRET', type: 'secret_text' },
            { name: 'OTP_HMAC_SECRET', type: 'secret_text' },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      return successfulCommandResult();
    });

    await expect(
      cleanupLegacyStaticSecrets({ env: 'test', rootDir }, ['ar-auth'])
    ).resolves.toEqual({ failures: [], activeVersionIds: { 'ar-auth': 'cleanup-v2' } });

    const bulkCalls = vi
      .mocked(execa)
      .mock.calls.filter(([, args]) => args.includes('delete'))
      .map(([, args]) => args);
    expect(bulkCalls).toHaveLength(0);
    const bulkCall = vi.mocked(execa).mock.calls.find(([, args]) => args.includes('bulk'));
    expect(bulkCall?.[1]).toEqual(expect.arrayContaining(['secret', 'bulk']));
    expect(bulkCall?.[2]).toMatchObject({
      input: JSON.stringify({ ADMIN_API_SECRET: null, KEY_MANAGER_SECRET: null }),
    });

    const listCall = vi
      .mocked(execa)
      .mock.calls.find(([, args]) => args.includes('secret') && args.includes('list'));
    expect(listCall?.[1]).toEqual(expect.arrayContaining(['--format', 'json']));
    expect(listCall?.[2]).toMatchObject({
      env: { WRANGLER_LOG: 'log' },
    });
  });

  it('reports a clear failure when Wrangler suppresses secret list JSON output', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    vi.mocked(execa).mockResolvedValue({
      ...successfulCommandResult(),
      stdout: '',
    } as Awaited<ReturnType<typeof execa>>);

    await expect(
      cleanupLegacyStaticSecrets({ env: 'test', rootDir }, ['ar-auth'])
    ).resolves.toEqual({
      failures: [
        {
          component: 'ar-auth',
          error: 'Wrangler secret list returned empty JSON output',
        },
      ],
      activeVersionIds: {},
    });
  });

  it('defers shared KeyManager and VersionManager cleanup during a partial rollout', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-lib-core', '1.0.0');

    await expect(
      cleanupLegacyStaticSecrets({ env: 'test', rootDir }, ['ar-lib-core'])
    ).resolves.toEqual({ failures: [], activeVersionIds: {} });
    expect(execa).not.toHaveBeenCalled();
  });

  it('cleans shared provider secrets after the full former-caller cohort succeeds', async () => {
    const rootDir = createTempRoot();
    const components = ['ar-lib-core', 'ar-auth', 'ar-token', 'ar-management'] as const;
    for (const component of components) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }
    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const component = components.find((candidate) => options?.cwd?.endsWith(candidate));
      if (args.includes('deployments')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: `${component}-cleanup-deployment`,
              versions: [{ version_id: `${component}-cleanup-v2`, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (args.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify(
            component === 'ar-lib-core'
              ? [
                  { name: 'KEY_MANAGER_SECRET', type: 'secret_text' },
                  { name: 'VERSION_MANAGER_SECRET', type: 'secret_text' },
                ]
              : [{ name: 'KEY_MANAGER_SECRET', type: 'secret_text' }]
          ),
        } as Awaited<ReturnType<typeof execa>>;
      }
      return successfulCommandResult();
    });

    const result = await cleanupLegacyStaticSecrets({ env: 'test', rootDir }, components);

    expect(result.failures).toEqual([]);
    expect(result.activeVersionIds['ar-lib-core']).toBe('ar-lib-core-cleanup-v2');
    expect(
      vi
        .mocked(execa)
        .mock.calls.some(
          ([, args, options]) =>
            options?.cwd?.endsWith('ar-lib-core') &&
            args.includes('secret') &&
            args.includes('bulk')
        )
    ).toBe(true);
  });
});

describe('resolveExistingWorkerComponents', () => {
  it('uses Cloudflare deployment state instead of trusting a local lock entry', async () => {
    const rootDir = createTempRoot();
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const workerName = args?.[args.indexOf('--name') + 1];
      return {
        ...successfulCommandResult(),
        stdout:
          workerName === 'test-ar-auth'
            ? JSON.stringify([{ id: 'active-auth' }])
            : JSON.stringify([]),
      } as Awaited<ReturnType<typeof execa>>;
    });

    await expect(
      resolveExistingWorkerComponents({ env: 'test', rootDir, concurrency: 2 }, [
        'ar-auth',
        'ar-token',
      ])
    ).resolves.toEqual(['ar-auth']);
  });

  it('treats only a confirmed not-found response as absent and fails closed otherwise', async () => {
    const rootDir = createTempRoot();
    vi.mocked(execa)
      .mockResolvedValueOnce({
        ...successfulCommandResult(),
        exitCode: 1,
        stderr: 'Worker does not exist [code: 10007]',
      } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({
        ...successfulCommandResult(),
        exitCode: 1,
        stderr: '401 authentication failed',
      } as Awaited<ReturnType<typeof execa>>);

    await expect(
      resolveExistingWorkerComponents({ env: 'test', rootDir }, ['ar-auth'])
    ).resolves.toEqual([]);
    await expect(
      resolveExistingWorkerComponents({ env: 'test', rootDir }, ['ar-auth'])
    ).rejects.toThrow('401 authentication failed');
  });
});

describe('deployWorkerGradually', () => {
  it('uses the exact baseline and uploaded version IDs for staged traffic splits', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const oldVersionId = '11111111-1111-4111-8111-111111111111';
    const newVersionId = '22222222-2222-4222-8222-222222222222';
    const trafficCommands: string[][] = [];
    const sleep = vi.fn(async () => undefined);
    const healthCheck = vi.fn(async () => ({ success: true }));
    let secretFilePath: string | undefined;

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              versions: [{ version_id: oldVersionId, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        expectOptimizedWorkerUpload(commandArgs);
        const outputDirectory = options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY;
        expect(outputDirectory).toBeTypeOf('string');
        const secretsFileIndex = commandArgs.indexOf('--secrets-file');
        expect(secretsFileIndex).toBeGreaterThan(-1);
        secretFilePath = commandArgs[secretsFileIndex + 1];
        expect(JSON.parse(readFileSync(secretFilePath, 'utf-8'))).toEqual({
          FLOW_RUNTIME_HMAC_SECRET: 'flow-secret',
        });
        writeFileSync(
          join(String(outputDirectory), 'wrangler-output.ndjson'),
          `${JSON.stringify({
            type: 'version-upload',
            version: 1,
            worker_name: 'test-ar-auth',
            version_id: newVersionId,
          })}\n`
        );
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        trafficCommands.push(commandArgs);
      }
      return successfulCommandResult();
    });

    const result = await deployWorkerGradually(
      'ar-auth',
      {
        env: 'test',
        rootDir,
        existingComponents: ['ar-auth'],
        secrets: { FLOW_RUNTIME_HMAC_SECRET: 'flow-secret' },
        sleep,
      },
      {
        stages: [10, 100],
        stabilizationDelayMs: 1,
        stageWaitMs: 1,
        healthCheck,
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        cloudflareVersionId: newVersionId,
      })
    );
    expect(trafficCommands).toHaveLength(2);
    expect(trafficCommands[0]).toEqual(
      expect.arrayContaining([
        'versions',
        'deploy',
        `${oldVersionId}@90%`,
        `${newVersionId}@10%`,
        '--yes',
      ])
    );
    expect(trafficCommands[1]).toEqual(
      expect.arrayContaining(['versions', 'deploy', `${newVersionId}@100%`, '--yes'])
    );
    for (const command of trafficCommands) {
      expect(command).not.toContain('--minify');
      expect(command).not.toContain('--upload-source-maps');
    }
    expect(trafficCommands[1]).not.toContain(oldVersionId);
    expect(healthCheck).toHaveBeenCalledTimes(2);
    expect(healthCheck).toHaveBeenNthCalledWith(1, 10);
    expect(healthCheck).toHaveBeenNthCalledWith(2, 100);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(secretFilePath).toBeDefined();
    expect(existsSync(secretFilePath!)).toBe(false);
  });

  it('rolls traffic back to the exact baseline version when a health check fails', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const oldVersionId = '33333333-3333-4333-8333-333333333333';
    const newVersionId = '44444444-4444-4444-8444-444444444444';
    const trafficCommands: string[][] = [];
    const sleep = vi.fn(async () => undefined);

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              versions: [{ version_id: oldVersionId, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        const outputDirectory = options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY;
        writeFileSync(
          join(String(outputDirectory), 'wrangler-output.ndjson'),
          `${JSON.stringify({
            type: 'version-upload',
            version: 1,
            worker_name: 'test-ar-auth',
            version_id: newVersionId,
          })}\n`
        );
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        trafficCommands.push(commandArgs);
      }
      return successfulCommandResult();
    });

    const result = await deployWorkerGradually(
      'ar-auth',
      {
        env: 'test',
        rootDir,
        existingComponents: ['ar-auth'],
        sleep,
      },
      {
        stages: [10, 100],
        stabilizationDelayMs: 1,
        healthCheck: async () => ({ success: false, error: 'HTTP 503' }),
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Health check failed at 10%: HTTP 503');
    expect(trafficCommands).toHaveLength(2);
    expect(trafficCommands[0]).toEqual(
      expect.arrayContaining([`${oldVersionId}@90%`, `${newVersionId}@10%`])
    );
    expect(trafficCommands[1]).toEqual(
      expect.arrayContaining(['versions', 'deploy', `${oldVersionId}@100%`, '--yes'])
    );
    expect(trafficCommands[1]).not.toContain(`${newVersionId}@100%`);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('checks the final 100% stage and rolls back before applying real triggers', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const oldVersionId = '55555555-5555-4555-8555-555555555555';
    const newVersionId = '66666666-6666-4666-8666-666666666666';
    const trafficCommands: string[][] = [];
    const triggerCommands: string[][] = [];

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([{ versions: [{ version_id: oldVersionId, percentage: 100 }] }]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: newVersionId })}\n`
        );
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        trafficCommands.push(commandArgs);
      } else if (commandArgs.includes('triggers')) {
        triggerCommands.push(commandArgs);
      }
      return successfulCommandResult();
    });

    const result = await deployWorkerGradually(
      'ar-auth',
      { env: 'test', rootDir, sleep: async () => undefined },
      {
        stages: [100],
        stabilizationDelayMs: 1,
        healthCheck: async () => ({ success: false, error: 'final probe failed' }),
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Health check failed at 100%');
    expect(trafficCommands).toHaveLength(2);
    expect(trafficCommands[0]).toContain(`${newVersionId}@100%`);
    expect(trafficCommands[1]).toContain(`${oldVersionId}@100%`);
    expect(triggerCommands).toHaveLength(1);
    expect(triggerCommands[0]).toContain('--dry-run');
    expect(triggerCommands[0]).not.toContain('--minify');
    expect(triggerCommands[0]).not.toContain('--upload-source-maps');
  });

  it('reports committed traffic without unsafe rollback when final trigger sync fails', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const oldVersionId = '77777777-7777-4777-8777-777777777777';
    const newVersionId = '88888888-8888-4888-8888-888888888888';
    const trafficCommands: string[][] = [];

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([{ versions: [{ version_id: oldVersionId, percentage: 100 }] }]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: newVersionId })}\n`
        );
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        trafficCommands.push(commandArgs);
      } else if (commandArgs.includes('triggers') && !commandArgs.includes('--dry-run')) {
        throw commandError('400 invalid route');
      }
      return successfulCommandResult();
    });

    const result = await deployWorkerGradually(
      'ar-auth',
      { env: 'test', rootDir, sleep: async () => undefined },
      {
        stages: [100],
        stabilizationDelayMs: 0,
        healthCheck: async () => ({ success: true }),
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        trafficCommitted: true,
        cloudflareVersionId: newVersionId,
      })
    );
    expect(result.error).toContain('trigger synchronization failed');
    expect(trafficCommands).toHaveLength(1);
    expect(trafficCommands[0]).toContain(`${newVersionId}@100%`);
  });
});

describe('deployUiWorkerComponent', () => {
  it('fails closed when reused Login UI output was built for another OAuth client', () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    const outputDirectory = join(
      rootDir,
      'packages',
      'ar-login-ui',
      '.svelte-kit',
      'cloudflare',
      '_app',
      'immutable',
      'chunks'
    );
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, 'client.js'), 'const clientId="login-ui";');

    expect(() =>
      assertLoginUiBuildClientId(join(rootDir, 'packages', 'ar-login-ui'), 'client-123')
    ).toThrow('login_ui_build_client_id_mismatch');
  });

  it('accepts Login UI output containing the configured OAuth client', () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    const outputDirectory = join(rootDir, 'packages', 'ar-login-ui', '.svelte-kit', 'cloudflare');
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, '_worker.js'), 'const clientId="client-123";');

    expect(() =>
      assertLoginUiBuildClientId(join(rootDir, 'packages', 'ar-login-ui'), 'client-123')
    ).not.toThrow();
  });

  it('fails closed before upload when UI Static Assets contain a source map', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    const publicChunkDirectory = join(
      rootDir,
      'packages',
      'ar-login-ui',
      '.svelte-kit',
      'cloudflare',
      '_app',
      'immutable',
      'chunks'
    );
    mkdirSync(publicChunkDirectory, { recursive: true });
    writeFileSync(join(publicChunkDirectory, 'client.js.map'), '{"version":3}');

    const result = await deployUiWorkerComponent('ar-login-ui', {
      env: 'test',
      rootDir,
      skipBuild: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'ui_public_source_maps_forbidden:1',
      })
    );
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
  });

  it('deploys Admin UI BFF secrets in one temporary secrets file and cleans it up', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-admin-ui');
    const adminUiBffSecrets = {
      ADMIN_UI_BFF_CLIENT_ID: 'authrim-admin-ui-bff',
      ADMIN_UI_BFF_KEY_ID: 'bff-key-1',
      ADMIN_UI_BFF_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      ADMIN_UI_BFF_SCOPES: 'admin-ui:proxy',
    };
    let secretFilePath: string | undefined;
    let uploadedSecrets: Record<string, string> | undefined;
    let secretFileMode: number | undefined;

    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const commandArgs = args ?? [];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: '[]',
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('deploy')) {
        expectOptimizedWorkerUpload(commandArgs);
        const secretsFileIndex = commandArgs.indexOf('--secrets-file');
        expect(secretsFileIndex).toBeGreaterThan(-1);
        secretFilePath = commandArgs[secretsFileIndex + 1];
        uploadedSecrets = JSON.parse(readFileSync(secretFilePath, 'utf-8')) as Record<
          string,
          string
        >;
        secretFileMode = statSync(secretFilePath).mode & 0o777;
      }
      return successfulCommandResult();
    });

    const result = await deployUiWorkerComponent('ar-admin-ui', {
      env: 'test',
      rootDir,
      adminUiBffSecrets,
    });

    expect(result.success).toBe(true);
    expect(uploadedSecrets).toEqual(adminUiBffSecrets);
    expect(secretFileMode).toBe(0o600);
    expect(secretFilePath).toBeDefined();
    expect(existsSync(secretFilePath!)).toBe(false);

    const deployCalls = vi.mocked(execa).mock.calls.filter(([, args]) => args?.includes('deploy'));
    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]).toEqual([
      'pnpm',
      expect.arrayContaining([
        'exec',
        'wrangler',
        'deploy',
        '--config',
        'wrangler.toml',
        '--secrets-file',
      ]),
      expect.objectContaining({ cwd: join(rootDir, 'packages', 'ar-admin-ui') }),
    ]);
    expect(
      vi
        .mocked(execa)
        .mock.calls.some(([, args]) =>
          args?.some((argument, index) => argument === 'secret' && args[index + 1] === 'put')
        )
    ).toBe(false);
  });

  it('uploads Static Assets as a version and explicitly promotes existing UI Workers', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    const versionId = '99999999-9999-4999-8999-999999999999';
    const wranglerCommands: string[][] = [];

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([{ id: 'existing-deployment' }]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        expectOptimizedWorkerUpload(commandArgs);
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: versionId })}\n`
        );
      }
      if (commandArgs.includes('wrangler')) {
        wranglerCommands.push(commandArgs);
      }
      return successfulCommandResult();
    });

    const result = await deployUiWorkerComponent('ar-login-ui', {
      env: 'test',
      rootDir,
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, cloudflareVersionId: versionId })
    );
    expect(
      wranglerCommands.some((args) => args.includes('versions') && args.includes('upload'))
    ).toBe(true);
    expect(
      wranglerCommands.some(
        (args) =>
          args.includes('versions') && args.includes('deploy') && args.includes(`${versionId}@100%`)
      )
    ).toBe(true);
    for (const command of wranglerCommands.filter(
      (args) => args.includes('versions') && args.includes('deploy')
    )) {
      expect(command).not.toContain('--minify');
      expect(command).not.toContain('--upload-source-maps');
    }
    const triggerDeployCommands = wranglerCommands.filter(
      (args) => args.includes('triggers') && args.includes('deploy')
    );
    expect(triggerDeployCommands).toHaveLength(2);
    for (const command of triggerDeployCommands) {
      expect(command).not.toContain('--minify');
      expect(command).not.toContain('--upload-source-maps');
    }
    expect(wranglerCommands.some((args) => args[2] === 'wrangler' && args[3] === 'deploy')).toBe(
      false
    );
  });
});

describe('deployUiWorkerBindingTargets', () => {
  it('pre-deploys UI Workers without service bindings or custom routes before router deploy', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    createUiPackage(rootDir, 'ar-admin-ui');
    vi.mocked(execa).mockImplementation(
      async (_command, args) =>
        ({
          exitCode: 0,
          stdout: args?.includes('deployments') ? '[]' : '',
          stderr: '',
        }) as Awaited<ReturnType<typeof execa>>
    );

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
  it('holds the shared Control DB lease around every existing Worker mutation', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-lib-core', '1.0.0');
    const leaseCalls: string[] = [];
    const commandCalls: string[] = [];
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      commandCalls.push(args.join(' '));
      if (args.includes('deployments') && args.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: 'deployment-source',
              versions: [{ version_id: 'version-source', percentage: 100 }],
            },
          ]),
        };
      }
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        existingComponents: ['ar-lib-core'],
        deploymentLease: {
          controlDatabaseId: '11111111-1111-1111-1111-111111111111',
          environmentId: 'test',
          actorId: 'setup:test',
          required: true,
          coordinator: fakeDeploymentLeaseCoordinator(leaseCalls),
        },
      },
      ['ar-lib-core']
    );

    expect(summary.failedCount).toBe(0);
    expect(commandCalls.filter((command) => command.includes('deployments list'))).toHaveLength(2);
    expect(commandCalls.some((command) => command.includes('wrangler deploy'))).toBe(true);
    expect(leaseCalls).toEqual([
      'acquire:test-ar-lib-core:version-source',
      'renew:test-ar-lib-core:1',
      'start:test-ar-lib-core:deployment-source',
      'assert:test-ar-lib-core:2',
      'release:test-ar-lib-core:2',
      'complete:true:',
    ]);
  });

  it('leases an absent Worker during a non-bootstrap deployment', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-lib-core', '1.0.0');
    const leaseCalls: string[] = [];
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      if (args.includes('deployments') && args.includes('list')) {
        return {
          ...successfulCommandResult(),
          exitCode: 1,
          stderr: 'Worker not found',
        };
      }
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        existingComponents: [],
        deploymentLease: {
          controlDatabaseId: '11111111-1111-1111-1111-111111111111',
          environmentId: 'test',
          actorId: 'setup:test',
          required: true,
          coordinator: fakeDeploymentLeaseCoordinator(leaseCalls),
        },
      },
      ['ar-lib-core']
    );

    expect(summary.failedCount).toBe(0);
    expect(leaseCalls).toEqual([
      'acquire:test-ar-lib-core:__absent__',
      'renew:test-ar-lib-core:1',
      'start:test-ar-lib-core:undefined',
      'assert:test-ar-lib-core:2',
      'release:test-ar-lib-core:2',
      'complete:true:',
    ]);
  });

  it('keeps every core Worker in the deployment plan', async () => {
    const rootDir = createTempRoot();
    for (const component of CORE_WORKER_COMPONENTS) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }

    const summary = await deployAll({ env: 'test', rootDir, dryRun: true });

    expect(summary.failedCount).toBe(0);
    expect(summary.results.map((result) => result.component).sort()).toEqual(
      [...CORE_WORKER_COMPONENTS].sort()
    );
    expect(summary.results.map((result) => result.component)).toContain('ar-agent-access');
  });

  it('fails before mutation when a fresh Control Worker lacks baseline split tokens', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-control', '1.0.0');

    await expect(deployAll({ env: 'test', rootDir }, ['ar-control'])).rejects.toThrow(
      'control_plane_baseline_secrets_missing:RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A,TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID,SMOKE_RPC_SIGNING_JWK_SLOT_A,CLOUDFLARE_D1_API_TOKEN,CLOUDFLARE_WORKERS_API_TOKEN'
    );
    expect(execa).not.toHaveBeenCalled();
  });

  it('allows a fresh Control Worker with baseline split tokens and no optional plugin tokens', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-control', '1.0.0');
    vi.mocked(execa).mockResolvedValue(successfulCommandResult());

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        secrets: {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          CLOUDFLARE_D1_API_TOKEN: 'd1-token',
          CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
        },
      },
      ['ar-control']
    );

    expect(summary.successCount).toBe(1);
    expect(summary.failedCount).toBe(0);
  });

  it('allows a fresh Control Worker without Cloudflare tokens when Automatic provisioning is off', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-control', '1.0.0');
    vi.mocked(execa).mockResolvedValue(successfulCommandResult());

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        automaticProvisioning: false,
        secrets: {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
        },
      },
      ['ar-control']
    );

    expect(summary.successCount).toBe(1);
    expect(summary.failedCount).toBe(0);
  });

  it('repairs a missing transitive dependency even when the requested Worker already exists', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-plugin-runner', '1.0.0');
    createWorkerPackage(rootDir, 'ar-bridge', '1.0.0');
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const started: string[] = [];
    vi.mocked(execa).mockImplementation(async (_command, _args, options) => {
      started.push(basename(String(options?.cwd)));
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        existingComponents: ['ar-lib-core', 'ar-auth'],
        deploymentStrategy: 'auto',
      },
      ['ar-auth']
    );

    expect(summary.successCount).toBe(3);
    expect(summary.results.map((result) => result.component)).toEqual([
      'ar-plugin-runner',
      'ar-bridge',
      'ar-auth',
    ]);
    expect(started).toEqual(['ar-plugin-runner', 'ar-bridge', 'ar-auth']);
  });

  it('runs the first-deploy dependency DAG with a maximum concurrency of two', async () => {
    const rootDir = createTempRoot();
    const selected = [
      'ar-lib-core',
      'ar-bridge',
      'ar-auth',
      'ar-management',
      'ar-token',
      'ar-router',
    ] as const;
    for (const component of selected) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }

    const releases = new Map(
      selected.map((component) => [component, createDeferred<Awaited<ReturnType<typeof execa>>>()])
    );
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    vi.mocked(execa).mockImplementation(async (_command, _args, options) => {
      const component = basename(String(options?.cwd));
      const release = releases.get(component as (typeof selected)[number]);
      expect(release).toBeDefined();
      started.push(component);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await release!.promise;
      } finally {
        active--;
      }
    });

    const deployment = deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        concurrency: 2,
      },
      [...selected]
    );

    await vi.waitFor(() => expect(started).toEqual(['ar-lib-core']));
    releases.get('ar-lib-core')!.resolve(successfulCommandResult());

    await vi.waitFor(() => {
      expect(started[0]).toBe('ar-lib-core');
      expect(new Set(started.slice(1))).toEqual(new Set(['ar-bridge', 'ar-token']));
    });
    expect(maxActive).toBe(2);

    // ar-auth is unlocked as soon as ar-bridge completes, even while ar-token is still running.
    releases.get('ar-bridge')!.resolve(successfulCommandResult());
    await vi.waitFor(() => expect(started).toContain('ar-auth'));
    expect(started).not.toContain('ar-management');

    releases.get('ar-auth')!.resolve(successfulCommandResult());
    await vi.waitFor(() => expect(started).toContain('ar-management'));

    releases.get('ar-management')!.resolve(successfulCommandResult());
    expect(started).not.toContain('ar-router');
    releases.get('ar-token')!.resolve(successfulCommandResult());
    await vi.waitFor(() => expect(started.at(-1)).toBe('ar-router'));
    releases.get('ar-router')!.resolve(successfulCommandResult());

    const summary = await deployment;
    expect(summary.successCount).toBe(selected.length);
    expect(summary.failedCount).toBe(0);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(started.at(-1)).toBe('ar-router');
  });

  it('bootstraps Auth and Bridge, deploys Management, then restores full bindings', async () => {
    const rootDir = createTempRoot();
    const selected = [
      'ar-lib-core',
      'ar-control',
      'ar-plugin-runner',
      'ar-bridge',
      'ar-auth',
      'ar-management',
      'ar-vc',
    ] as const;
    for (const component of selected) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }
    const authDirectory = join(rootDir, 'packages', 'ar-auth');
    const bootstrapPath = join(authDirectory, 'wrangler.bootstrap.toml');
    const bridgeDirectory = join(rootDir, 'packages', 'ar-bridge');
    const bridgeBootstrapPath = join(bridgeDirectory, 'wrangler.bootstrap.toml');
    writeFileSync(
      join(authDirectory, 'wrangler.toml'),
      'name = "test-ar-auth"\n\n[[services]]\nbinding = "ACCOUNT_PROVISIONER"\nservice = "test-ar-management"\n'
    );
    writeFileSync(bootstrapPath, 'name = "test-ar-auth"\n');
    writeFileSync(
      join(bridgeDirectory, 'wrangler.toml'),
      'name = "test-ar-bridge"\n\n[[services]]\nbinding = "EXTERNAL_IDP_ACCOUNT_PROVISIONER"\nservice = "test-ar-management"\n'
    );
    writeFileSync(bridgeBootstrapPath, 'name = "test-ar-bridge"\n');

    const mutations: Array<{
      component: string;
      bootstrap: 'auth' | 'bridge' | false;
      args: string[];
    }> = [];
    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      mutations.push({
        component: basename(String(options?.cwd)),
        bootstrap: commandArgs.includes(bootstrapPath)
          ? 'auth'
          : commandArgs.includes(bridgeBootstrapPath)
            ? 'bridge'
            : false,
        args: commandArgs,
      });
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        concurrency: 2,
        existingComponents: ['ar-auth', 'ar-bridge'],
        secrets: {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          CLOUDFLARE_D1_API_TOKEN: 'd1-token',
          CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
        },
      },
      [...selected]
    );

    expect(summary.failedCount).toBe(0);
    const authMutations = mutations.filter(({ component }) => component === 'ar-auth');
    expect(authMutations.map(({ component, bootstrap }) => ({ component, bootstrap }))).toEqual([
      { component: 'ar-auth', bootstrap: 'auth' },
      { component: 'ar-auth', bootstrap: false },
    ]);
    const bridgeMutations = mutations.filter(({ component }) => component === 'ar-bridge');
    expect(bridgeMutations.map(({ component, bootstrap }) => ({ component, bootstrap }))).toEqual([
      { component: 'ar-bridge', bootstrap: 'bridge' },
      { component: 'ar-bridge', bootstrap: false },
    ]);
    for (const mutation of mutations) {
      expectOptimizedWorkerUpload(mutation.args);
    }
    const managementIndex = mutations.findIndex(({ component }) => component === 'ar-management');
    expect(managementIndex).toBeGreaterThan(
      mutations.findIndex(
        ({ component, bootstrap }) => component === 'ar-auth' && bootstrap === 'auth'
      )
    );
    expect(managementIndex).toBeLessThan(
      mutations.findIndex(({ component, bootstrap }) => component === 'ar-auth' && !bootstrap)
    );
    expect(managementIndex).toBeGreaterThan(
      mutations.findIndex(
        ({ component, bootstrap }) => component === 'ar-bridge' && bootstrap === 'bridge'
      )
    );
    expect(managementIndex).toBeLessThan(
      mutations.findIndex(({ component, bootstrap }) => component === 'ar-bridge' && !bootstrap)
    );
  });

  it('bootstraps Control until every runtime smoke target exists, then restores bindings', async () => {
    const rootDir = createTempRoot();
    const selected = [...CORE_WORKER_COMPONENTS];
    for (const component of selected) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }
    const controlDirectory = join(rootDir, 'packages', 'ar-control');
    const controlBootstrapPath = join(controlDirectory, 'wrangler.bootstrap.toml');
    writeFileSync(
      join(controlDirectory, 'wrangler.toml'),
      'name = "test-ar-control"\n\n[[services]]\nbinding = "SMOKE_AR_AUTH"\nservice = "test-ar-auth"\n'
    );
    writeFileSync(controlBootstrapPath, 'name = "test-ar-control"\n');

    const mutations: Array<{ component: string; config: string | undefined }> = [];
    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const configIndex = (args ?? []).indexOf('--config');
      mutations.push({
        component: basename(String(options?.cwd)),
        config: configIndex >= 0 ? args?.[configIndex + 1] : undefined,
      });
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        concurrency: 2,
        existingComponents: ['ar-control'],
        automaticProvisioning: false,
        secrets: {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
        },
      },
      selected
    );

    expect(summary.failedCount).toBe(0);
    expect(mutations.filter(({ component }) => component === 'ar-control')).toEqual([
      { component: 'ar-control', config: controlBootstrapPath },
      { component: 'ar-control', config: 'wrangler.toml' },
    ]);
    expect(mutations.every(({ config }) => config !== undefined)).toBe(true);
  });

  it('waits for the VC service-binding target before deploying management', async () => {
    const rootDir = createTempRoot();
    const selected = ['ar-lib-core', 'ar-bridge', 'ar-auth', 'ar-vc', 'ar-management'] as const;
    for (const component of selected) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }

    const releases = new Map(
      selected.map((component) => [component, createDeferred<Awaited<ReturnType<typeof execa>>>()])
    );
    const started: string[] = [];
    vi.mocked(execa).mockImplementation(async (_command, _args, options) => {
      const component = basename(String(options?.cwd));
      started.push(component);
      return releases.get(component as (typeof selected)[number])!.promise;
    });

    const deployment = deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        concurrency: 2,
      },
      [...selected]
    );

    await vi.waitFor(() => expect(started).toEqual(['ar-lib-core']));
    releases.get('ar-lib-core')!.resolve(successfulCommandResult());
    await vi.waitFor(() => {
      expect(started[0]).toBe('ar-lib-core');
      expect(started.slice(1)).toHaveLength(2);
      expect(new Set(started.slice(1))).toEqual(new Set(['ar-bridge', 'ar-vc']));
    });

    releases.get('ar-bridge')!.resolve(successfulCommandResult());
    await vi.waitFor(() => expect(started).toContain('ar-auth'));
    releases.get('ar-auth')!.resolve(successfulCommandResult());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).not.toContain('ar-management');

    releases.get('ar-vc')!.resolve(successfulCommandResult());
    await vi.waitFor(() => expect(started.at(-1)).toBe('ar-management'));
    releases.get('ar-management')!.resolve(successfulCommandResult());

    const summary = await deployment;
    expect(summary.failedCount).toBe(0);
  });

  it('uploads every staged version before promoting in dependency order and applying triggers', async () => {
    const rootDir = createTempRoot();
    const selected = ['ar-lib-core', 'ar-bridge', 'ar-auth', 'ar-management', 'ar-router'] as const;
    for (const component of selected) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }

    const versionIds = new Map(
      selected.map((component, index) => [
        component,
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      ])
    );
    const commandEvents: Array<{
      component: string;
      kind: 'upload' | 'trigger-validation' | 'promote' | 'triggers';
      args: string[];
    }> = [];

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      const component = basename(String(options?.cwd));
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        commandEvents.push({ component, kind: 'upload', args: commandArgs });
        const outputDirectory = options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY;
        expect(outputDirectory).toBeTypeOf('string');
        writeFileSync(
          join(String(outputDirectory), 'wrangler-output.ndjson'),
          `${JSON.stringify({
            type: 'version-upload',
            version: 1,
            worker_name: `test-${component}`,
            version_id: versionIds.get(component as (typeof selected)[number]),
          })}\n`
        );
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        commandEvents.push({ component, kind: 'promote', args: commandArgs });
      } else if (commandArgs.includes('triggers')) {
        commandEvents.push({
          component,
          kind: commandArgs.includes('--dry-run') ? 'trigger-validation' : 'triggers',
          args: commandArgs,
        });
      } else if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: `baseline-${component}`,
              versions: [{ version_id: `old-${component}`, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'staged',
        existingComponents: CORE_WORKER_COMPONENTS,
        concurrency: 2,
      },
      [...selected]
    );

    expect(summary.successCount).toBe(selected.length);
    expect(summary.failedCount).toBe(0);
    const lastUploadIndex = commandEvents.findLastIndex((event) => event.kind === 'upload');
    const firstPromotionIndex = commandEvents.findIndex((event) => event.kind === 'promote');
    expect(lastUploadIndex).toBeGreaterThanOrEqual(0);
    expect(firstPromotionIndex).toBeGreaterThan(lastUploadIndex);
    const lastValidationIndex = commandEvents.findLastIndex(
      (event) => event.kind === 'trigger-validation'
    );
    const firstTriggerIndex = commandEvents.findIndex((event) => event.kind === 'triggers');
    const lastPromotionIndex = commandEvents.findLastIndex((event) => event.kind === 'promote');
    expect(firstPromotionIndex).toBeGreaterThan(lastValidationIndex);
    expect(firstTriggerIndex).toBeGreaterThan(lastPromotionIndex);

    expect(commandEvents.filter((event) => event.kind === 'upload')).toHaveLength(selected.length);
    for (const event of commandEvents.filter((candidate) => candidate.kind === 'upload')) {
      expectOptimizedWorkerUpload(event.args);
    }
    expect(
      commandEvents.filter((event) => event.kind === 'promote').map((event) => event.component)
    ).toEqual([...selected]);
    expect(
      commandEvents.filter((event) => event.kind === 'triggers').map((event) => event.component)
    ).toEqual([...selected]);

    for (const event of commandEvents.filter((candidate) => candidate.kind === 'promote')) {
      expect(event.args).toEqual(
        expect.arrayContaining([
          `${versionIds.get(event.component as (typeof selected)[number])}@100%`,
          '--yes',
          '--env',
          'test',
        ])
      );
      expect(event.args).not.toContain('--minify');
      expect(event.args).not.toContain('--upload-source-maps');
    }
    for (const event of commandEvents.filter((candidate) => candidate.kind === 'triggers')) {
      expect(event.args).not.toContain('--minify');
      expect(event.args).not.toContain('--upload-source-maps');
    }
  });

  it('does not promote any staged version when one upload fails', async () => {
    const rootDir = createTempRoot();
    const selected = ['ar-auth', 'ar-token'] as const;
    for (const component of selected) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = args ?? [];
      const component = basename(String(options?.cwd));
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        if (component === 'ar-auth') {
          throw commandError('400 Invalid Worker module');
        }
        const outputDirectory = options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY;
        writeFileSync(
          join(String(outputDirectory), 'wrangler-output.ndjson'),
          `${JSON.stringify({
            type: 'version-upload',
            version: 1,
            worker_name: `test-${component}`,
            version_id: '00000000-0000-4000-8000-000000000001',
          })}\n`
        );
      }
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'staged',
        existingComponents: ['ar-lib-core', 'ar-plugin-runner', 'ar-bridge', ...selected],
        concurrency: 2,
      },
      [...selected]
    );

    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(selected.length);
    expect(
      vi
        .mocked(execa)
        .mock.calls.some(([, args]) =>
          args?.some((argument, index) => argument === 'versions' && args[index + 1] === 'deploy')
        )
    ).toBe(false);
    expect(vi.mocked(execa).mock.calls.some(([, args]) => args?.includes('triggers'))).toBe(false);
  });

  it('rolls back already-started staged promotions and never applies real triggers on failure', async () => {
    const rootDir = createTempRoot();
    const selected = ['ar-lib-core', 'ar-token'] as const;
    for (const component of selected) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }
    const trafficCommands: Array<{ component: string; args: string[] }> = [];
    const realTriggers: string[] = [];

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      const component = basename(String(options?.cwd));
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: `new-${component}` })}\n`
        );
      } else if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            { versions: [{ version_id: `old-${component}`, percentage: 100 }] },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        trafficCommands.push({ component, args: commandArgs });
        if (component === 'ar-token' && commandArgs.includes('new-ar-token@100%')) {
          throw commandError('400 invalid deployment');
        }
      } else if (commandArgs.includes('triggers') && !commandArgs.includes('--dry-run')) {
        realTriggers.push(component);
      }
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        existingComponents: CORE_WORKER_COMPONENTS,
        deploymentStrategy: 'staged',
        concurrency: 2,
      },
      [...selected]
    );

    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(2);
    expect(realTriggers).toEqual([]);
    expect(
      trafficCommands.map(({ component, args }) => [
        component,
        args.find((argument) => argument.endsWith('%')),
      ])
    ).toEqual([
      ['ar-lib-core', 'new-ar-lib-core@100%'],
      ['ar-token', 'new-ar-token@100%'],
      ['ar-token', 'old-ar-token@100%'],
      ['ar-lib-core', 'old-ar-lib-core@100%'],
    ]);
    expect(summary.results.every((result) => result.error?.includes('Rolled back'))).toBe(true);
  });

  it('skips dependent Workers after a critical Worker fails', async () => {
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

    expect(result.failedCount).toBe(2);
    expect(result.results.map((item) => item.component)).toEqual(['ar-lib-core', 'ar-auth']);
    expect(result.results[1]).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Skipped because dependency ar-lib-core failed',
      })
    );
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
  });
});
