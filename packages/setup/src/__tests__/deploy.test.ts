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
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import {
  buildApiPackages,
  buildUiWorkerBuildEnv,
  assertLoginUiBuildClientId,
  cleanupLegacyStaticSecrets,
  deployAll as deployAllCore,
  deployUiWorkerComponent as deployUiWorkerComponentCore,
  deployUiWorkerBindingTargets as deployUiWorkerBindingTargetsCore,
  deployWorker as deployWorkerCore,
  deployWorkerGradually as deployWorkerGraduallyCore,
  findNodeEngineMismatches,
  hasBlockingDeploymentFailures,
  isLocalDiskExhaustionError,
  loadDeploySecretsFromKeys,
  nodeVersionSatisfiesEngine,
  reconcileWorkerCronTriggers,
  resolveExistingWorkerComponents,
  updateLockWithDeployments,
  type DeployOptions,
  type WorkerDeploymentLeaseCoordinator,
} from '../core/deploy.js';
import type { WorkerScriptOwnershipGuard } from '../core/worker-script-ownership.js';
import { CORE_WORKER_COMPONENTS } from '../core/naming.js';
import type { SetupWorkerDeploymentLease } from '../core/worker-deployment-lease.js';
import {
  acquireDeployConfigLock,
  AuthrimLockSchema,
  type DeployConfigLock,
  type DeployConfigLockProof,
} from '../core/lock.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const tempDirs: string[] = [];
const TEST_CLOUDFLARE_VERSION_ID = '77777777-7777-4777-8777-777777777777';
const TEST_CLOUDFLARE_SCRIPT_TAG = 'test-worker-script-immutable-tag';
const testWorkerScriptOwnership: WorkerScriptOwnershipGuard = {
  assertBeforeMutation: async () => undefined,
  checkpointCommittedVersion: async () => undefined,
  captureAfterMutation: async () => TEST_CLOUDFLARE_SCRIPT_TAG,
  getEvidence: (workerName) => ({
    workerName,
    state: 'owned',
    tag: TEST_CLOUDFLARE_SCRIPT_TAG,
  }),
};

const deployWorker = (
  ...[component, options]: Parameters<typeof deployWorkerCore>
): ReturnType<typeof deployWorkerCore> =>
  deployWorkerCore(component, {
    readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
    ...options,
    workerScriptOwnership: testWorkerScriptOwnership,
  });

const deployWorkerGradually = (
  ...[component, options, gradual]: Parameters<typeof deployWorkerGraduallyCore>
): ReturnType<typeof deployWorkerGraduallyCore> =>
  deployWorkerGraduallyCore(
    component,
    {
      readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
      ...options,
      workerScriptOwnership: testWorkerScriptOwnership,
    },
    gradual
  );

const deployAll = (
  ...[options, components]: Parameters<typeof deployAllCore>
): ReturnType<typeof deployAllCore> =>
  deployAllCore(
    {
      readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
      ...options,
      workerScriptOwnership: testWorkerScriptOwnership,
    },
    components
  );

const deployUiWorkerComponent = (
  ...[component, options]: Parameters<typeof deployUiWorkerComponentCore>
): ReturnType<typeof deployUiWorkerComponentCore> =>
  deployUiWorkerComponentCore(component, {
    readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
    ...options,
    workerScriptOwnership: testWorkerScriptOwnership,
  });

const deployUiWorkerBindingTargets = (
  ...[options, targets]: Parameters<typeof deployUiWorkerBindingTargetsCore>
): ReturnType<typeof deployUiWorkerBindingTargetsCore> =>
  deployUiWorkerBindingTargetsCore(
    {
      readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
      ...options,
      workerScriptOwnership: testWorkerScriptOwnership,
    },
    targets
  );

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

function createWorkerPackageWithCrons(
  rootDir: string,
  component: string,
  version: string,
  crons: readonly string[]
): void {
  createWorkerPackage(rootDir, component, version);
  writeFileSync(
    join(rootDir, 'packages', component, 'wrangler.toml'),
    [
      `name = "test-${component}"`,
      '',
      '[env.test]',
      `name = "test-${component}"`,
      '',
      '[env.test.triggers]',
      `crons = [${crons.map((cron) => JSON.stringify(cron)).join(', ')}]`,
      '',
    ].join('\n')
  );
}

function createManagedWorkerPackage(
  rootDir: string,
  component: string,
  version: string,
  databaseId = '11111111-1111-4111-8111-111111111111'
): void {
  createWorkerPackage(rootDir, component, version);
  writeFileSync(
    join(rootDir, 'packages', component, 'wrangler.toml'),
    [
      'main = "src/index.ts"',
      'compatibility_date = "2026-08-30"',
      '',
      '[build]',
      'command = "node ../../scripts/guard-managed-worker-deploy.mjs"',
      '',
      '[env.test]',
      `name = "test-${component}"`,
      '',
      '[[env.test.d1_databases]]',
      'binding = "DB"',
      'database_name = "test-core"',
      `database_id = "${databaseId}"`,
      '',
    ].join('\n')
  );
}

function consumeManagedDeployTicket(options: { env?: Record<string, string> } | undefined): void {
  const ticketPath = options?.env?.AUTHRIM_MANAGED_DEPLOY_TICKET;
  if (ticketPath) {
    writeFileSync(join(dirname(ticketPath), 'consumed'), 'used', { mode: 0o600 });
  }
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

async function acquireManagedDeployProof(rootDir: string, env = 'test'): Promise<DeployConfigLock> {
  mkdirSync(join(rootDir, '.authrim', env), { recursive: true });
  return acquireDeployConfigLock({ baseDir: rootDir, env, operation: 'deploy-test' });
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
    stdout: JSON.stringify({ type: 'deploy', version_id: TEST_CLOUDFLARE_VERSION_ID }),
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
    initialNotificationProviderSuccess: true,
    initialAdminRolesSuccess: true,
    setupMachineAccessSuccess: true,
    setupMachineAccessCleanupSuccess: true,
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
    'initialNotificationProviderSuccess',
    'initialAdminRolesSuccess',
    'setupMachineAccessSuccess',
    'setupMachineAccessCleanupSuccess',
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
      readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
    });

    expect(result.success).toBe(true);
    expect(progressMessages).toContain('Building ar-auth...');
    expect(vi.mocked(execa)).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'turbo', 'run', 'build', '--filter=@authrim/ar-auth'],
      expect.objectContaining({ cwd: rootDir })
    );
  });

  it('stops before turbo when local disk space is insufficient', async () => {
    const rootDir = createTempRoot();
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });

    const result = await buildApiPackages({
      rootDir,
      components: ['ar-auth'],
      readAvailableDiskBytes: async () => 144 * 1024 * 1024,
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'insufficient_local_disk_space',
      error: expect.stringContaining('144 MiB available'),
    });
    expect(
      vi
        .mocked(execa)
        .mock.calls.some(([command, args]) => command === 'pnpm' && args.includes('turbo'))
    ).toBe(false);
  });

  it('stops before Worker mutations when the build consumes the remaining disk reserve', async () => {
    const rootDir = createTempRoot();
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    const observations = [2 * 1024 * 1024 * 1024, 144 * 1024 * 1024];

    const result = await buildApiPackages({
      rootDir,
      components: ['ar-auth'],
      readAvailableDiskBytes: async () => observations.shift() ?? 0,
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'insufficient_local_disk_space',
      error: expect.stringContaining('Worker deployment'),
    });
    expect(
      vi
        .mocked(execa)
        .mock.calls.some(([command, args]) => command === 'pnpm' && args.includes('turbo'))
    ).toBe(true);
  });
});

describe('isLocalDiskExhaustionError', () => {
  it.each([
    'ENOSPC: write failed',
    'no space left on device',
    'Insufficient local disk space for package build',
    'insufficient_local_disk_space',
  ])('recognizes %s', (message) => {
    expect(isLocalDiskExhaustionError(new Error(message))).toBe(true);
  });

  it('does not classify an ordinary Wrangler failure as disk exhaustion', () => {
    expect(isLocalDiskExhaustionError(new Error('authentication failed'))).toBe(false);
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

  it('requires an issued workspace capability for a managed environment', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    mkdirSync(join(rootDir, '.authrim', 'test'), { recursive: true });

    await expect(
      deployWorker('ar-auth', { env: 'test', rootDir, deploymentStrategy: 'direct' })
    ).rejects.toThrow('managed_worker_deploy_config_lock_proof_required:test');
    expect(execa).not.toHaveBeenCalled();
  });

  it('rejects forged, cross-environment, and cross-workspace capabilities', async () => {
    const rootDir = createTempRoot();
    const otherRootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const fakeProof = {
      assertOwned: vi.fn(async () => undefined),
    } as unknown as DeployConfigLockProof;

    await expect(
      deployWorker('ar-auth', {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        deployConfigLockProof: fakeProof,
      })
    ).rejects.toThrow('deploy_config_lock_proof_invalid');

    const wrongEnvironment = await acquireManagedDeployProof(rootDir, 'scaleout');
    try {
      await expect(
        deployWorker('ar-auth', {
          env: 'test',
          rootDir,
          deploymentStrategy: 'direct',
          deployConfigLockProof: wrongEnvironment.proof,
        })
      ).rejects.toThrow('deploy_config_lock_proof_environment_mismatch');
    } finally {
      await wrongEnvironment.release();
    }

    const wrongWorkspace = await acquireManagedDeployProof(otherRootDir, 'test');
    try {
      await expect(
        deployWorker('ar-auth', {
          env: 'test',
          rootDir,
          deploymentStrategy: 'direct',
          deployConfigLockProof: wrongWorkspace.proof,
        })
      ).rejects.toThrow('deploy_config_lock_proof_workspace_mismatch');
    } finally {
      await wrongWorkspace.release();
    }
    expect(execa).not.toHaveBeenCalled();
  });

  it('rejects released capability before configuration refresh or provider mutation', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    await deployConfigLock.release();

    await expect(
      deployWorker('ar-auth', {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        deployConfigLockProof: deployConfigLock.proof,
      })
    ).rejects.toThrow('deploy_config_lock_proof_released');
    expect(execa).not.toHaveBeenCalled();
  });

  it('revalidates the same capability after generated configuration refresh', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);

    await expect(
      deployWorker('ar-auth', {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        deployConfigLockProof: deployConfigLock.proof,
        beforeWorkerMutations: () => deployConfigLock.release(),
      })
    ).rejects.toThrow('deploy_config_lock_proof_released');
    expect(execa).not.toHaveBeenCalled();
  });

  it('does not allow managed proof enforcement to be downgraded after entry', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    const options: DeployOptions = {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      deployConfigLockProof: deployConfigLock.proof,
      workerScriptOwnership: testWorkerScriptOwnership,
      beforeWorkerMutations: async () => {
        options.dryRun = true;
        options.deployConfigLockProof = undefined;
      },
    };

    try {
      await expect(deployWorkerCore('ar-auth', options)).rejects.toThrow(
        'managed_worker_deploy_config_lock_proof_changed:test'
      );
      expect(execa).not.toHaveBeenCalled();
    } finally {
      await deployConfigLock.release();
    }
  });

  it('does not replay when capability ownership is lost after direct deploy returns', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    let deployCalls = 0;
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      if (args.includes('deploy')) {
        deployCalls++;
        await deployConfigLock.release();
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 3,
      sleep: async () => undefined,
      deployConfigLockProof: deployConfigLock.proof,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        trafficCommitted: true,
        error: 'Direct deployment state became unverifiable for test-ar-auth',
      })
    );
    expect(deployCalls).toBe(1);
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

  it('fails closed without replaying an ambiguous Cloudflare 503 deployment', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const sleep = vi.fn(async () => undefined);
    let deployAttempts = 0;
    vi.mocked(execa).mockImplementation(async (_command, _args) => {
      deployAttempts++;
      throw commandError('503 Service Unavailable');
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 3,
      retryDelayMs: 2,
      random: () => 0.5,
      sleep,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Direct deployment outcome is ambiguous for test-ar-auth',
      })
    );
    expect(deployAttempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('adopts the active version and retries only triggers after a partial trigger deployment', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-router', '1.0.0');
    const activeVersionId = 'router-version-after-partial-trigger-failure';
    const sleep = vi.fn(async () => undefined);
    let deployAttempts = 0;
    let triggerAttempts = 0;

    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: 'router-deployment-after-trigger-failure',
              versions: [{ version_id: activeVersionId, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('triggers') && commandArgs.includes('deploy')) {
        triggerAttempts++;
        if (triggerAttempts === 1) {
          throw commandError(
            'Some triggers failed to deploy for test-ar-router:\n' +
              '  - A request to the Cloudflare API (/accounts/account/workers/scripts/test-ar-router/domains/records) failed.'
          );
        }
        return successfulCommandResult();
      }
      if (commandArgs.includes('deploy')) {
        deployAttempts++;
        throw commandError(
          'Some triggers failed to deploy for test-ar-router:\n' +
            '  - A request to the Cloudflare API (/accounts/account/workers/scripts/test-ar-router/domains/records) failed.'
        );
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-router', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 3,
      retryDelayMs: 2,
      random: () => 0.5,
      sleep,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        cloudflareVersionId: activeVersionId,
      })
    );
    expect(deployAttempts).toBe(1);
    expect(triggerAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('checkpoints fresh ownership before retrying triggers after a partial deployment', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-router', '1.0.0');
    const activeVersionId = '11111111-1111-4111-8111-111111111111';
    const events: string[] = [];
    let deployAttempts = 0;
    let triggerAttempts = 0;
    let ownershipState: 'absent' | 'pending' | 'owned' = 'absent';
    const ownership: WorkerScriptOwnershipGuard = {
      assertBeforeMutation: async () => {
        events.push(`assert:${ownershipState}`);
        if (deployAttempts > 0 && ownershipState !== 'owned') {
          throw new Error('worker_script_fresh_name_conflict:test-ar-router');
        }
      },
      checkpointCommittedVersion: async (_workerName, versionId) => {
        expect(versionId).toBe(activeVersionId);
        events.push('checkpoint');
        ownershipState = 'pending';
      },
      captureAfterMutation: async () => {
        events.push('capture');
        ownershipState = 'owned';
        return TEST_CLOUDFLARE_SCRIPT_TAG;
      },
      getEvidence: (workerName) =>
        ownershipState === 'owned'
          ? { workerName, state: 'owned', tag: TEST_CLOUDFLARE_SCRIPT_TAG }
          : { workerName, state: 'absent' },
    };

    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: 'router-deployment-after-trigger-failure',
              versions: [{ version_id: activeVersionId, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('triggers') && commandArgs.includes('deploy')) {
        triggerAttempts++;
        return successfulCommandResult();
      }
      if (commandArgs.includes('deploy')) {
        deployAttempts++;
        throw commandError(
          'Some triggers failed to deploy for test-ar-router:\n' +
            '  - A request to the Cloudflare API (/accounts/account/workers/scripts/test-ar-router/domains/records) failed.'
        );
      }
      return successfulCommandResult();
    });

    const result = await deployWorkerCore('ar-router', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 1,
      workerScriptOwnership: ownership,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        cloudflareVersionId: activeVersionId,
        cloudflareScriptTag: TEST_CLOUDFLARE_SCRIPT_TAG,
      })
    );
    expect(deployAttempts).toBe(1);
    expect(triggerAttempts).toBe(1);
    expect(events).toEqual([
      'assert:absent',
      'assert:absent',
      'checkpoint',
      'capture',
      'assert:owned',
      'checkpoint',
      'capture',
    ]);
  });

  it('reconciles and retries a transient Wrangler authentication code 10000 failure', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const sleep = vi.fn(async () => undefined);
    let deployAttempts = 0;
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          exitCode: 1,
          stderr: 'Worker not found [code: 10007]',
        };
      }
      deployAttempts++;
      if (deployAttempts === 1) {
        throw commandError('Authentication error [code: 10000]');
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 3,
      // Keep the synthetic deadline well ahead of wall-clock execution so the assertion does
      // not depend on whether a 1 ms retry window elapsed between the failure and throttle check.
      retryDelayMs: 60_000,
      random: () => 0.5,
      sleep,
    });

    expect(result.success).toBe(true);
    expect(deployAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('rechecks immutable ownership before a retried provider mutation', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    let deployAttempts = 0;
    let ownershipChecks = 0;
    const racedOwnership: WorkerScriptOwnershipGuard = {
      ...testWorkerScriptOwnership,
      assertBeforeMutation: async () => {
        ownershipChecks++;
        if (ownershipChecks >= 3) {
          throw new Error('worker_script_immutable_tag_mismatch:test-ar-auth:tag-a:tag-b');
        }
      },
    };
    vi.mocked(execa).mockImplementation(async () => {
      deployAttempts++;
      throw commandError('Authentication error [code: 10000]');
    });

    const result = await deployWorkerCore('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 3,
      retryDelayMs: 1,
      sleep: async () => undefined,
      workerScriptOwnership: racedOwnership,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'worker_script_immutable_tag_mismatch:test-ar-auth:tag-a:tag-b',
    });
    expect(deployAttempts).toBe(1);
    expect(ownershipChecks).toBe(3);
  });

  it('journals a fresh direct version before tag readback and can be retried safely', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const checkpointCommittedVersion = vi.fn(async () => undefined);
    const firstOwnership: WorkerScriptOwnershipGuard = {
      ...testWorkerScriptOwnership,
      checkpointCommittedVersion,
      captureAfterMutation: async () => {
        throw new Error(
          'worker_script_identity_readback_timeout:test-ar-auth:temporary inventory outage'
        );
      },
      getEvidence: (workerName) => ({ workerName, state: 'absent' }),
    };

    const first = await deployWorkerCore('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      workerScriptOwnership: firstOwnership,
    });
    expect(first).toMatchObject({
      success: false,
      trafficCommitted: true,
      cloudflareVersionId: TEST_CLOUDFLARE_VERSION_ID,
    });
    expect(checkpointCommittedVersion).toHaveBeenCalledWith(
      'test-ar-auth',
      TEST_CLOUDFLARE_VERSION_ID
    );

    const recovered = await deployWorkerCore('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      existingComponents: ['ar-auth'],
      workerScriptOwnership: testWorkerScriptOwnership,
    });
    expect(recovered).toMatchObject({
      success: true,
      cloudflareVersionId: TEST_CLOUDFLARE_VERSION_ID,
      cloudflareScriptTag: TEST_CLOUDFLARE_SCRIPT_TAG,
    });
  });

  it('adopts structured direct-deploy output after a lost 503 response without replaying', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    writeFileSync(
      join(rootDir, 'packages', 'ar-auth', 'wrangler.toml'),
      'name = "test-ar-auth"\n\n[[migrations]]\ntag = "v1"\nnew_classes = ["Store"]\n'
    );
    const versionId = '33333333-3333-4333-8333-333333333333';
    let deployAttempts = 0;

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deploy') && !commandArgs.includes('deployments')) {
        deployAttempts++;
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'deploy', version_id: versionId })}\n`
        );
        throw commandError('503 Service Unavailable');
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      existingComponents: ['ar-auth'],
      maxRetries: 3,
      sleep: async () => undefined,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        cloudflareVersionId: versionId,
      })
    );
    expect(deployAttempts).toBe(1);
  });

  it('fails closed when a lost direct-deploy response changed remote state without a version ID', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const sleep = vi.fn(async () => undefined);
    let deployAttempts = 0;

    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: 'deployment-after-response-loss',
              versions: [{ version_id: 'version-after-response-loss', percentage: 100 }],
            },
          ]),
        };
      }
      deployAttempts++;
      throw commandError('503 Service Unavailable');
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
      maxRetries: 3,
      retryDelayMs: 1,
      sleep,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Direct deployment outcome is ambiguous for test-ar-auth',
      })
    );
    expect(deployAttempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not replay an existing Durable Object migration deploy when its outcome is unknown', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    writeFileSync(
      join(rootDir, 'packages', 'ar-auth', 'wrangler.toml'),
      'name = "test-ar-auth"\n\n[[migrations]]\ntag = "v1"\nnew_classes = ["Store"]\n'
    );
    const sleep = vi.fn(async () => undefined);
    let deployAttempts = 0;
    vi.mocked(execa).mockImplementation(async () => {
      deployAttempts++;
      throw commandError('503 Service Unavailable');
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-auth'],
      maxRetries: 3,
      retryDelayMs: 1,
      sleep,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Direct deployment outcome is ambiguous for test-ar-auth',
      })
    );
    expect(deployAttempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not replay a leased Durable Object migration after an ambiguous response', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    writeFileSync(
      join(rootDir, 'packages', 'ar-auth', 'wrangler.toml'),
      'name = "test-ar-auth"\n\n[[migrations]]\ntag = "v1"\nnew_classes = ["Store"]\n'
    );
    const sleep = vi.fn(async () => undefined);
    const leaseCalls: string[] = [];
    let deployAttempts = 0;
    let trafficReads = 0;
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        trafficReads++;
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
      deployAttempts++;
      if (deployAttempts === 1) {
        throw commandError('503 Service Unavailable');
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-auth'],
      deploymentLease: {
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        environmentId: 'test',
        actorId: 'setup:test',
        required: true,
        coordinator: fakeDeploymentLeaseCoordinator(leaseCalls),
      },
      maxRetries: 3,
      retryDelayMs: 1,
      sleep,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Direct deployment outcome is ambiguous for test-ar-auth',
      })
    );
    expect(deployAttempts).toBe(1);
    expect(trafficReads).toBe(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(leaseCalls).toContain('acquire:test-ar-auth:version-source');
  });

  it('retries traffic promotion while an uploaded Worker version becomes visible', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const versionId = '22222222-2222-4222-8222-222222222222';
    const sleep = vi.fn(async () => undefined);
    let uploadAttempts = 0;
    let promotionAttempts = 0;

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        uploadAttempts++;
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: versionId })}\n`
        );
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        promotionAttempts++;
        if (promotionAttempts === 1) {
          throw commandError(
            'The requested Worker version could not be found, please check the ID [code: 100146]'
          );
        }
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-auth'],
      maxRetries: 3,
      retryDelayMs: 2,
      random: () => 0.5,
      sleep,
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, cloudflareVersionId: versionId })
    );
    expect(uploadAttempts).toBe(1);
    expect(promotionAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('verifies an uploaded version D1 binding contract before staged promotion', async () => {
    const rootDir = createTempRoot();
    const databaseId = '11111111-1111-4111-8111-111111111111';
    createManagedWorkerPackage(rootDir, 'ar-auth', '1.0.0', databaseId);
    const versionId = '22222222-2222-4222-8222-222222222222';
    const commands: string[][] = [];
    const events: string[] = [];

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      commands.push(commandArgs);
      if (commandArgs.includes('upload')) {
        events.push('upload');
        consumeManagedDeployTicket(options);
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: versionId })}\n`
        );
      } else if (commandArgs.includes('view')) {
        events.push('binding-readback');
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify({
            resources: { bindings: [{ name: 'DB', type: 'd1', id: databaseId }] },
          }),
        };
      }
      if (commandArgs.includes('deploy')) events.push('promote');
      return successfulCommandResult();
    });

    const result = await deployWorkerCore('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-auth'],
      workerScriptOwnership: {
        ...testWorkerScriptOwnership,
        checkpointCommittedVersion: async () => {
          events.push('checkpoint-version');
        },
        captureAfterMutation: async () => {
          events.push('capture-tag');
          return TEST_CLOUDFLARE_SCRIPT_TAG;
        },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, cloudflareVersionId: versionId })
    );
    const viewIndex = commands.findIndex((args) => args.includes('view'));
    const promoteIndex = commands.findIndex(
      (args) => args.includes('versions') && args.includes('deploy')
    );
    expect(viewIndex).toBeGreaterThan(-1);
    expect(promoteIndex).toBeGreaterThan(viewIndex);
    expect(events.indexOf('checkpoint-version')).toBeLessThan(events.indexOf('capture-tag'));
    expect(events.indexOf('capture-tag')).toBeLessThan(events.indexOf('binding-readback'));
    const viewCall = vi.mocked(execa).mock.calls.find(([, args]) => (args ?? []).includes('view'));
    expect(viewCall?.[2]?.env).toMatchObject({ WRANGLER_LOG: 'log' });
  });

  it('retries an empty uploaded-version binding readback before staged promotion', async () => {
    const rootDir = createTempRoot();
    const databaseId = '11111111-1111-4111-8111-111111111111';
    createManagedWorkerPackage(rootDir, 'ar-auth', '1.0.0', databaseId);
    const versionId = '22222222-2222-4222-8222-222222222222';
    let viewAttempts = 0;

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('upload')) {
        consumeManagedDeployTicket(options);
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: versionId })}\n`
        );
      } else if (commandArgs.includes('view')) {
        viewAttempts++;
        return {
          ...successfulCommandResult(),
          stdout:
            viewAttempts === 1
              ? ''
              : JSON.stringify({
                  resources: { bindings: [{ name: 'DB', type: 'd1', id: databaseId }] },
                }),
        };
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-auth'],
      maxRetries: 2,
      retryDelayMs: 0,
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, cloudflareVersionId: versionId })
    );
    expect(viewAttempts).toBe(2);
  });

  it.each([
    { label: 'missing', bindings: [], mismatch: 'DB' },
    {
      label: 'wrong database ID',
      bindings: [{ name: 'DB', type: 'd1', id: '99999999-9999-4999-8999-999999999999' }],
      mismatch: 'DB',
    },
    {
      label: 'unexpected extra',
      bindings: [
        { name: 'DB', type: 'd1', id: '11111111-1111-4111-8111-111111111111' },
        { name: 'EXTRA_DB', type: 'd1', id: '88888888-8888-4888-8888-888888888888' },
      ],
      mismatch: 'EXTRA_DB',
    },
  ])('blocks staged promotion for a $label D1 binding', async ({ bindings, mismatch }) => {
    const rootDir = createTempRoot();
    createManagedWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const versionId = '22222222-2222-4222-8222-222222222222';

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('upload')) {
        consumeManagedDeployTicket(options);
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: versionId })}\n`
        );
      } else if (commandArgs.includes('view')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify({ resources: { bindings } }),
        };
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-auth'],
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: `worker_version_d1_binding_mismatch:${mismatch}`,
      })
    );
    expect(result.trafficCommitted).toBeUndefined();
    expect(
      vi
        .mocked(execa)
        .mock.calls.some(
          ([, args]) => (args ?? []).includes('versions') && (args ?? []).includes('deploy')
        )
    ).toBe(false);
  });

  it('reports direct deployment binding mismatch as already traffic-committed', async () => {
    const rootDir = createTempRoot();
    createManagedWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const versionId = '33333333-3333-4333-8333-333333333333';

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deploy') && !commandArgs.includes('versions')) {
        consumeManagedDeployTicket(options);
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'deploy', version_id: versionId })}\n`
        );
      } else if (commandArgs.includes('view')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify({ resources: { bindings: [] } }),
        };
      }
      return successfulCommandResult();
    });

    const result = await deployWorker('ar-auth', {
      env: 'test',
      rootDir,
      deploymentStrategy: 'direct',
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        trafficCommitted: true,
        cloudflareVersionId: versionId,
        error: 'worker_version_d1_binding_mismatch:DB',
      })
    );
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
  it('requires the workspace capability before managed secret cleanup', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    mkdirSync(join(rootDir, '.authrim', 'test'), { recursive: true });

    await expect(cleanupLegacyStaticSecrets({ env: 'test', rootDir }, ['ar-auth'])).rejects.toThrow(
      'managed_worker_deploy_config_lock_proof_required:test'
    );
    expect(execa).not.toHaveBeenCalled();
  });

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

  it('reconciles the active version when a previous secret-bulk response was lost', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    const activeVersionId = 'cleanup-response-lost-version';

    vi.mocked(execa).mockImplementation(async (_command, args) => {
      if (args.includes('secret') && args.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: '[]',
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (args.includes('deployments') && args.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: 'cleanup-response-lost-deployment',
              versions: [{ version_id: activeVersionId, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      return successfulCommandResult();
    });

    try {
      await expect(
        cleanupLegacyStaticSecrets(
          { env: 'test', rootDir, deployConfigLockProof: deployConfigLock.proof },
          ['ar-auth']
        )
      ).resolves.toEqual({
        failures: [],
        activeVersionIds: { 'ar-auth': activeVersionId },
      });
      expect(vi.mocked(execa).mock.calls.some(([, args]) => args.includes('bulk'))).toBe(false);
    } finally {
      await deployConfigLock.release();
    }
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

  it('does not attempt gradual rollback after capability loss following traffic promotion', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-auth', '1.0.0');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    const oldVersionId = '91919191-9191-4191-8191-919191919191';
    const newVersionId = '92929292-9292-4292-8292-929292929292';
    const trafficCommands: string[][] = [];

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...args];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: 'baseline-deployment',
              versions: [{ version_id: oldVersionId, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: newVersionId })}\n`
        );
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        trafficCommands.push(commandArgs);
        await deployConfigLock.release();
      }
      return successfulCommandResult();
    });

    const result = await deployWorkerGradually(
      'ar-auth',
      {
        env: 'test',
        rootDir,
        sleep: async () => undefined,
        deployConfigLockProof: deployConfigLock.proof,
      },
      { stages: [100], stabilizationDelayMs: 0 }
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        trafficCommitted: true,
        cloudflareVersionId: newVersionId,
      })
    );
    expect(result.error).toContain('rollback skipped because the deploy-config lock was lost');
    expect(trafficCommands).toHaveLength(1);
    expect(trafficCommands[0]).toContain(`${newVersionId}@100%`);
    expect(trafficCommands[0]).not.toContain(`${oldVersionId}@100%`);
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

  it('stops before UI provider mutation when the workspace capability is lost during build', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      if (args.includes('build')) {
        await deployConfigLock.release();
      }
      return successfulCommandResult();
    });

    const result = await deployUiWorkerComponent('ar-login-ui', {
      env: 'test',
      rootDir,
      deployConfigLockProof: deployConfigLock.proof,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'deploy_config_lock_proof_released',
      })
    );
    expect(
      vi
        .mocked(execa)
        .mock.calls.some(([, args]) => args.includes('wrangler') && args.includes('deploy'))
    ).toBe(false);
  });

  it('reports committed ambiguity without retry when the UI capability is lost after deploy', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    let providerDeployCalls = 0;
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      if (args.includes('deployments') && args.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: '[]',
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (args.includes('wrangler') && args.includes('deploy')) {
        providerDeployCalls++;
        await deployConfigLock.release();
      }
      return successfulCommandResult();
    });

    const result = await deployUiWorkerComponent('ar-login-ui', {
      env: 'test',
      rootDir,
      skipBuild: true,
      maxRetries: 3,
      sleep: async () => undefined,
      deployConfigLockProof: deployConfigLock.proof,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        trafficCommitted: true,
        error: 'managed_worker_deploy_config_lock_proof_lost_after_mutation',
      })
    );
    expect(providerDeployCalls).toBe(1);
  });

  it('checkpoints a response-lost placeholder deploy and converges safely on retry', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    const committedVersionId = '81818181-8181-4181-8181-818181818181';
    const retryVersionId = '82828282-8282-4282-8282-828282828282';
    const scriptTag = 'ui-placeholder-immutable-script-tag';
    let deploymentListCalls = 0;
    let directDeployCalls = 0;
    let captureCalls = 0;
    const checkpointCommittedVersion = vi.fn(async () => undefined);
    const workerScriptOwnership: WorkerScriptOwnershipGuard = {
      assertBeforeMutation: async () => undefined,
      checkpointCommittedVersion,
      captureAfterMutation: async () => {
        captureCalls++;
        if (captureCalls === 1) {
          throw new Error('worker_script_tag_visibility_timeout');
        }
        return scriptTag;
      },
      getEvidence: (workerName) => ({ workerName, state: 'fresh' }),
    };

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        deploymentListCalls++;
        return {
          ...successfulCommandResult(),
          stdout:
            deploymentListCalls === 1 ? '[]' : JSON.stringify([{ id: 'existing-ui-deployment' }]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (
        commandArgs[0] === 'exec' &&
        commandArgs[1] === 'wrangler' &&
        commandArgs[2] === 'deploy'
      ) {
        directDeployCalls++;
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'deploy', version_id: committedVersionId })}\n`
        );
        throw new Error('socket hang up after provider commit');
      }
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: retryVersionId })}\n`
        );
      }
      return successfulCommandResult();
    });

    let firstAttempt!: Awaited<ReturnType<typeof deployUiWorkerBindingTargetsCore>>;
    let retryAttempt!: Awaited<ReturnType<typeof deployUiWorkerBindingTargetsCore>>;
    try {
      firstAttempt = await deployUiWorkerBindingTargetsCore(
        {
          env: 'test',
          rootDir,
          deployConfigLockProof: deployConfigLock.proof,
          workerScriptOwnership,
          maxRetries: 3,
          sleep: async () => undefined,
          readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
        },
        { loginUi: true, adminUi: false }
      );
      retryAttempt = await deployUiWorkerBindingTargetsCore(
        {
          env: 'test',
          rootDir,
          deployConfigLockProof: deployConfigLock.proof,
          workerScriptOwnership,
          maxRetries: 3,
          sleep: async () => undefined,
          readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
        },
        { loginUi: true, adminUi: false }
      );
    } finally {
      await deployConfigLock.release();
    }

    expect(firstAttempt.results[0]).toEqual(
      expect.objectContaining({
        success: false,
        trafficCommitted: true,
        cloudflareVersionId: committedVersionId,
        error: 'worker_script_tag_visibility_timeout',
      })
    );
    expect(retryAttempt.results[0]).toEqual(
      expect.objectContaining({
        success: true,
        cloudflareVersionId: retryVersionId,
        cloudflareScriptTag: scriptTag,
      })
    );
    expect(checkpointCommittedVersion.mock.calls).toEqual([
      ['test-ar-login-ui', committedVersionId],
      ['test-ar-login-ui', retryVersionId],
    ]);
    expect(directDeployCalls).toBe(1);
  });

  it('does not replay an ambiguous fresh UI deploy without a structured version ID', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    let directDeployCalls = 0;
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const commandArgs = [...(args ?? [])];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: '[]',
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (
        commandArgs[0] === 'exec' &&
        commandArgs[1] === 'wrangler' &&
        commandArgs[2] === 'deploy'
      ) {
        directDeployCalls++;
        throw new Error('socket hang up without structured output');
      }
      return successfulCommandResult();
    });

    const result = await deployUiWorkerComponent('ar-login-ui', {
      env: 'test',
      rootDir,
      skipBuild: true,
      maxRetries: 3,
      sleep: async () => undefined,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Direct UI deployment outcome is ambiguous for test-ar-login-ui',
      })
    );
    expect(result.trafficCommitted).toBeUndefined();
    expect(directDeployCalls).toBe(1);
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
  it('requires the workspace capability before creating managed placeholder Workers', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    mkdirSync(join(rootDir, '.authrim', 'test'), { recursive: true });

    await expect(
      deployUiWorkerBindingTargets({ env: 'test', rootDir }, { loginUi: true, adminUi: false })
    ).rejects.toThrow('managed_worker_deploy_config_lock_proof_required:test');
    expect(execa).not.toHaveBeenCalled();
  });

  it('pre-deploys UI Workers without service bindings or custom routes before router deploy', async () => {
    const rootDir = createTempRoot();
    createUiPackage(rootDir, 'ar-login-ui');
    createUiPackage(rootDir, 'ar-admin-ui');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    vi.mocked(execa).mockImplementation(
      async (_command, args) =>
        ({
          exitCode: 0,
          stdout: args?.includes('deployments')
            ? '[]'
            : JSON.stringify({
                type: 'deploy',
                version_id: TEST_CLOUDFLARE_VERSION_ID,
              }),
          stderr: '',
        }) as Awaited<ReturnType<typeof execa>>
    );

    const result = await deployUiWorkerBindingTargets(
      {
        env: 'test',
        rootDir,
        apiBaseUrl: 'https://test.example.com',
        deployConfigLockProof: deployConfigLock.proof,
      },
      {
        loginUi: true,
        adminUi: true,
      }
    );
    await deployConfigLock.release();

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

describe('updateLockWithDeployments', () => {
  const sourceLock = () =>
    AuthrimLockSchema.parse({
      version: '1.0.0',
      productVersion: '1.0.0',
      createdAt: '2026-08-31T00:00:00.000Z',
      env: 'test',
      d1: {},
      kv: {},
      workers: {
        'ar-control': {
          name: 'test-ar-control',
          version: '1.0.0',
          deployedAt: '2026-08-31T00:00:00.000Z',
          cloudflareVersionId: '00000000-0000-4000-8000-000000000001',
        },
      },
    });

  it('does not advance a Worker whose post-traffic reconciliation failed', () => {
    const lock = sourceLock();
    const updated = updateLockWithDeployments(lock, [
      {
        component: 'ar-control',
        workerName: 'test-ar-control',
        success: false,
        trafficCommitted: true,
        error: 'trigger synchronization failed',
        version: '1.1.0',
        deployedAt: '2026-08-31T00:01:00.000Z',
        cloudflareVersionId: '00000000-0000-4000-8000-000000000002',
        cloudflareScriptTag: TEST_CLOUDFLARE_SCRIPT_TAG,
      },
    ]);
    expect(updated.workers?.['ar-control']).toEqual(lock.workers?.['ar-control']);
  });

  it('persists exact successful versions and rejects incomplete evidence', () => {
    const lock = sourceLock();
    const updated = updateLockWithDeployments(lock, [
      {
        component: 'ar-control',
        workerName: 'test-ar-control',
        success: true,
        version: '1.1.0',
        deployedAt: '2026-08-31T00:01:00.000Z',
        cloudflareVersionId: '00000000-0000-4000-8000-000000000002',
        cloudflareScriptTag: TEST_CLOUDFLARE_SCRIPT_TAG,
      },
    ]);
    expect(updated.workers?.['ar-control']).toMatchObject({
      version: '1.1.0',
      cloudflareVersionId: '00000000-0000-4000-8000-000000000002',
      cloudflareScriptTag: TEST_CLOUDFLARE_SCRIPT_TAG,
    });
    expect(() =>
      updateLockWithDeployments(lock, [
        {
          component: 'ar-control',
          workerName: 'test-ar-control',
          success: true,
          version: '1.1.0',
          deployedAt: '2026-08-31T00:01:00.000Z',
        },
      ])
    ).toThrow('worker_deployment_exact_version_unavailable:ar-control');
  });
});

describe('reconcileWorkerCronTriggers', () => {
  const managementCrons = ['* * * * *', '*/2 * * * *', '*/5 * * * *', '0 */6 * * *'] as const;

  it('accepts an exact provider schedule set without mutating the Worker', async () => {
    const rootDir = createTempRoot();
    createWorkerPackageWithCrons(rootDir, 'ar-management', '1.0.0', managementCrons);
    const readWorkerCronTriggers = vi.fn().mockResolvedValue([...managementCrons].reverse());

    await reconcileWorkerCronTriggers(
      {
        env: 'test',
        rootDir,
        cloudflareAccountId: '11111111111111111111111111111111',
        readWorkerCronTriggers,
        workerScriptOwnership: testWorkerScriptOwnership,
      },
      ['ar-management']
    );

    expect(readWorkerCronTriggers).toHaveBeenCalledWith(
      'test-ar-management',
      '11111111111111111111111111111111'
    );
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
  });

  it('reapplies missing schedules and requires an exact provider readback', async () => {
    const rootDir = createTempRoot();
    createWorkerPackageWithCrons(rootDir, 'ar-management', '1.0.0', managementCrons);
    const readWorkerCronTriggers = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([...managementCrons]);

    await reconcileWorkerCronTriggers(
      {
        env: 'test',
        rootDir,
        readWorkerCronTriggers,
        workerScriptOwnership: testWorkerScriptOwnership,
      },
      ['ar-management']
    );

    expect(readWorkerCronTriggers).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execa)).toHaveBeenCalledOnce();
    expect(vi.mocked(execa).mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['triggers', 'deploy', '--config', 'wrangler.toml', '--env', 'test'])
    );
  });

  it('fails the resume when provider schedules remain inconsistent after repair', async () => {
    const rootDir = createTempRoot();
    createWorkerPackageWithCrons(rootDir, 'ar-management', '1.0.0', managementCrons);
    const readWorkerCronTriggers = vi.fn().mockResolvedValue([]);

    await expect(
      reconcileWorkerCronTriggers(
        {
          env: 'test',
          rootDir,
          readWorkerCronTriggers,
          workerScriptOwnership: testWorkerScriptOwnership,
        },
        ['ar-management']
      )
    ).rejects.toThrow('worker_cron_reconciliation_failed:ar-management');
    expect(readWorkerCronTriggers).toHaveBeenCalledTimes(5);
    expect(vi.mocked(execa)).toHaveBeenCalledOnce();
  });
});

describe('deployAll', () => {
  it('rejects insufficient disk capacity before any Worker command starts', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-bridge', '1.0.0');

    await expect(
      deployAll(
        {
          env: 'test',
          rootDir,
          deploymentStrategy: 'direct',
          readAvailableDiskBytes: async () => 144 * 1024 * 1024,
        },
        ['ar-bridge']
      )
    ).rejects.toMatchObject({ code: 'insufficient_local_disk_space' });
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
  });

  it('stops scheduling independent Workers after local disk exhaustion', async () => {
    const rootDir = createTempRoot();
    for (const component of ['ar-bridge', 'ar-userinfo', 'ar-vc']) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }
    const deployedComponents: string[] = [];
    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      if (args.includes('deploy')) {
        const component = basename(String(options?.cwd));
        deployedComponents.push(component);
        if (component === 'ar-bridge') {
          throw commandError('ENOSPC: no space left on device, write');
        }
      }
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        concurrency: 1,
        maxRetries: 0,
      },
      ['ar-bridge', 'ar-userinfo', 'ar-vc']
    );

    expect(deployedComponents).toEqual(['ar-bridge']);
    expect(summary.failedCount).toBe(3);
    expect(summary.results.find((result) => result.component === 'ar-bridge')?.error).toContain(
      'no space left on device'
    );
    expect(summary.results.find((result) => result.component === 'ar-userinfo')?.error).toContain(
      'local disk space was exhausted'
    );
    expect(summary.results.find((result) => result.component === 'ar-vc')?.error).toContain(
      'local disk space was exhausted'
    );
  });

  it('does not issue staged rollback after the workspace capability is lost post-promotion', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-lib-core', '1.0.0');
    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    const oldVersionId = '93939393-9393-4393-8393-939393939393';
    const newVersionId = '94949494-9494-4494-8494-949494949494';
    const trafficCommands: string[][] = [];

    vi.mocked(execa).mockImplementation(async (_command, args, options) => {
      const commandArgs = [...args];
      if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
        return {
          ...successfulCommandResult(),
          stdout: JSON.stringify([
            {
              id: 'staged-baseline',
              versions: [{ version_id: oldVersionId, percentage: 100 }],
            },
          ]),
        } as Awaited<ReturnType<typeof execa>>;
      }
      if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
        writeFileSync(
          join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
          `${JSON.stringify({ type: 'version-upload', version_id: newVersionId })}\n`
        );
      } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
        trafficCommands.push(commandArgs);
        await deployConfigLock.release();
      }
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'staged',
        existingComponents: ['ar-lib-core'],
        maxRetries: 3,
        sleep: async () => undefined,
        deployConfigLockProof: deployConfigLock.proof,
      },
      ['ar-lib-core']
    );

    expect(summary.results[0]).toEqual(
      expect.objectContaining({ success: false, trafficCommitted: true })
    );
    expect(summary.results[0].error).toContain(
      'rollback skipped because the deploy-config lock was lost'
    );
    expect(trafficCommands).toHaveLength(1);
    expect(trafficCommands[0]).toContain(`${newVersionId}@100%`);
    expect(trafficCommands[0]).not.toContain(`${oldVersionId}@100%`);
  });

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
        beforeWorkerMutations: async () => {
          leaseCalls.push('refresh-generated-bindings');
        },
      },
      ['ar-lib-core']
    );

    expect(summary.failedCount).toBe(0);
    expect(commandCalls.filter((command) => command.includes('deployments list'))).toHaveLength(2);
    expect(commandCalls.some((command) => command.includes('wrangler deploy'))).toBe(true);
    expect(leaseCalls).toEqual([
      'refresh-generated-bindings',
      'acquire:test-ar-lib-core:version-source',
      'renew:test-ar-lib-core:1',
      'start:test-ar-lib-core:deployment-source',
      'assert:test-ar-lib-core:2',
      'release:test-ar-lib-core:2',
      'complete:true:',
    ]);
  });

  it('refreshes package configuration before choosing the deployment strategy and baseline', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-lib-core', '1.0.0');
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
        deploymentStrategy: 'staged',
        existingComponents: ['ar-lib-core'],
        deploymentLease: {
          controlDatabaseId: '11111111-1111-1111-1111-111111111111',
          environmentId: 'test',
          actorId: 'setup:test',
          required: true,
          coordinator: fakeDeploymentLeaseCoordinator([]),
        },
        beforeWorkerMutations: async () => {
          writeFileSync(
            join(rootDir, 'packages', 'ar-lib-core', 'wrangler.toml'),
            'name = "test-ar-lib-core"\n\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["SessionStore"]\n'
          );
        },
      },
      ['ar-lib-core']
    );

    expect(summary.failedCount).toBe(0);
    expect(commandCalls.some((command) => command.includes('wrangler deploy'))).toBe(true);
    expect(commandCalls.some((command) => command.includes('versions upload'))).toBe(false);
  });

  it('fails closed when a managed environment package config drifts from its generated master', async () => {
    const rootDir = createTempRoot();
    createManagedWorkerPackage(rootDir, 'ar-lib-core', '1.0.0');
    const masterDir = join(rootDir, '.authrim', 'test', 'wrangler');
    mkdirSync(masterDir, { recursive: true });
    writeFileSync(join(rootDir, '.authrim', 'test', 'config.json'), '{}');
    writeFileSync(
      join(masterDir, 'ar-lib-core.toml'),
      readFileSync(join(rootDir, 'packages', 'ar-lib-core', 'wrangler.toml'), 'utf8').replace(
        'test-ar-lib-core',
        'test-ar-lib-core-generated'
      )
    );

    const deployConfigLock = await acquireManagedDeployProof(rootDir);
    try {
      const summary = await deployAll(
        {
          env: 'test',
          rootDir,
          deploymentStrategy: 'direct',
          existingComponents: [],
          deployConfigLockProof: deployConfigLock.proof,
        },
        ['ar-lib-core']
      );

      expect(summary.failedCount).toBe(1);
      expect(summary.results[0].error).toContain('managed_worker_deploy_config_mismatch');
      expect(execa).not.toHaveBeenCalled();
    } finally {
      await deployConfigLock.release();
    }
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

  it('bootstraps Control on an initial deployment, then restores bindings', async () => {
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
        existingComponents: [],
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

  it('keeps a Control-only initial deployment on the bootstrap config for credential setup', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-control', '1.0.0');
    const controlDirectory = join(rootDir, 'packages', 'ar-control');
    const controlBootstrapPath = join(controlDirectory, 'wrangler.bootstrap.toml');
    writeFileSync(
      join(controlDirectory, 'wrangler.toml'),
      'name = "test-ar-control"\n\n[[services]]\nbinding = "SMOKE_AR_AUTH"\nservice = "test-ar-auth"\n'
    );
    writeFileSync(controlBootstrapPath, 'name = "test-ar-control"\n');

    const configs: Array<string | undefined> = [];
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const configIndex = (args ?? []).indexOf('--config');
      configs.push(configIndex >= 0 ? args?.[configIndex + 1] : undefined);
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        existingComponents: [],
        automaticProvisioning: false,
        deferInitialControlSmokeBindingRestore: true,
        secrets: {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
        },
      },
      ['ar-control']
    );

    expect(summary.failedCount).toBe(0);
    expect(summary.successCount).toBe(1);
    expect(configs).toEqual([controlBootstrapPath]);
  });

  it('retries an incomplete Control-only bootstrap without restoring unavailable smoke bindings', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-control', '1.0.0');
    const controlDirectory = join(rootDir, 'packages', 'ar-control');
    const controlBootstrapPath = join(controlDirectory, 'wrangler.bootstrap.toml');
    writeFileSync(
      join(controlDirectory, 'wrangler.toml'),
      'name = "test-ar-control"\n\n[[services]]\nbinding = "SMOKE_AR_AUTH"\nservice = "test-ar-auth"\n'
    );
    writeFileSync(controlBootstrapPath, 'name = "test-ar-control"\n');

    const configs: Array<string | undefined> = [];
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const configIndex = (args ?? []).indexOf('--config');
      configs.push(configIndex >= 0 ? args?.[configIndex + 1] : undefined);
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        existingComponents: ['ar-control'],
        automaticProvisioning: false,
        deferInitialControlSmokeBindingRestore: true,
        secrets: {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
        },
      },
      ['ar-control']
    );

    expect(summary.failedCount).toBe(0);
    expect(configs).toEqual([controlBootstrapPath]);
  });

  it('rejects deferred Control smoke restoration outside the initial Control-only contract', async () => {
    const rootDir = createTempRoot();
    for (const component of ['ar-control', 'ar-auth'] as const) {
      createWorkerPackage(rootDir, component, '1.0.0');
    }
    const controlDirectory = join(rootDir, 'packages', 'ar-control');
    writeFileSync(
      join(controlDirectory, 'wrangler.toml'),
      'name = "test-ar-control"\n\n[[services]]\nbinding = "SMOKE_AR_AUTH"\nservice = "test-ar-auth"\n'
    );
    writeFileSync(join(controlDirectory, 'wrangler.bootstrap.toml'), 'name = "test-ar-control"\n');

    await expect(
      deployAll(
        {
          env: 'test',
          rootDir,
          deploymentStrategy: 'direct',
          existingComponents: [],
          automaticProvisioning: false,
          deferInitialControlSmokeBindingRestore: true,
          secrets: {
            RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
            TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
            SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          },
        },
        ['ar-control', 'ar-auth']
      )
    ).rejects.toThrow('initial_control_bootstrap_only_contract_invalid');
    expect(execa).not.toHaveBeenCalled();
  });

  it('keeps the full Control config when every smoke target already exists', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-control', '1.0.0');
    const controlDirectory = join(rootDir, 'packages', 'ar-control');
    const controlBootstrapPath = join(controlDirectory, 'wrangler.bootstrap.toml');
    writeFileSync(
      join(controlDirectory, 'wrangler.toml'),
      'name = "test-ar-control"\n\n[[services]]\nbinding = "SMOKE_AR_AUTH"\nservice = "test-ar-auth"\n'
    );
    writeFileSync(controlBootstrapPath, 'name = "test-ar-control"\n');

    const configs: Array<string | undefined> = [];
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const configIndex = (args ?? []).indexOf('--config');
      configs.push(configIndex >= 0 ? args?.[configIndex + 1] : undefined);
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        existingComponents: [...CORE_WORKER_COMPONENTS],
        automaticProvisioning: false,
        secrets: {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
        },
      },
      ['ar-control']
    );

    expect(summary.failedCount).toBe(0);
    expect(configs).toEqual(['wrangler.toml']);
    expect(configs).not.toContain(controlBootstrapPath);
  });

  it('reuses the Control bootstrap config while missing smoke targets are deployed', async () => {
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
  });

  it('fails safe to the full Control config when the existing inventory is unknown', async () => {
    const rootDir = createTempRoot();
    createWorkerPackage(rootDir, 'ar-control', '1.0.0');
    const controlDirectory = join(rootDir, 'packages', 'ar-control');
    writeFileSync(
      join(controlDirectory, 'wrangler.toml'),
      'name = "test-ar-control"\n\n[[services]]\nbinding = "SMOKE_AR_AUTH"\nservice = "test-ar-auth"\n'
    );
    writeFileSync(join(controlDirectory, 'wrangler.bootstrap.toml'), 'name = "test-ar-control"\n');

    const configs: Array<string | undefined> = [];
    vi.mocked(execa).mockImplementation(async (_command, args) => {
      const configIndex = (args ?? []).indexOf('--config');
      configs.push(configIndex >= 0 ? args?.[configIndex + 1] : undefined);
      return successfulCommandResult();
    });

    const summary = await deployAll(
      {
        env: 'test',
        rootDir,
        deploymentStrategy: 'direct',
        automaticProvisioning: false,
        secrets: {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
        },
      },
      ['ar-control']
    );

    expect(summary.failedCount).toBe(0);
    expect(configs).toEqual(['wrangler.toml']);
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
