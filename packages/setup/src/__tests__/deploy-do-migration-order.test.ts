import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import {
  classifyDurableObjectMigrations,
  cleanupLegacyStaticSecrets,
  deployAll as deployAllCore,
  type DeployOptions,
} from '../core/deploy.js';
import { parseWranglerMigrationTags } from '../core/wrangler.js';
import type { WorkerScriptOwnershipGuard } from '../core/worker-script-ownership.js';

vi.mock('execa', () => ({ execa: vi.fn() }));

const VERSION_ID = '77777777-7777-4777-8777-777777777777';
const ownership: WorkerScriptOwnershipGuard = {
  assertBeforeMutation: async () => undefined,
  checkpointCommittedVersion: async () => undefined,
  captureAfterMutation: async () => 'test-script-tag',
  getEvidence: (workerName) => ({ workerName, state: 'owned', tag: 'test-script-tag' }),
};

const tempDirs: string[] = [];

const MIGRATIONS_TOML = [
  '# Durable Objects Migrations',
  '[[migrations]]',
  'tag = "v1"',
  'new_sqlite_classes = [',
  '  "SessionStore",',
  ']',
  '',
  '[[migrations]]',
  'tag = "v2"',
  'new_sqlite_classes = [',
  '  "UserCodeRateLimiter",',
  ']',
  '',
].join('\n');

/** `migrationsIn` is the Worker whose wrangler config carries Durable Object migrations. */
function createRoot(migrationsIn: 'ar-lib-core' | 'ar-token' = 'ar-lib-core'): string {
  const dir = mkdtempSync(join(tmpdir(), 'authrim-do-order-test-'));
  tempDirs.push(dir);
  for (const component of ['ar-lib-core', 'ar-token']) {
    const packageDir = join(dir, 'packages', component);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'wrangler.toml'),
      `name = "test-${component}"\n\n${component === migrationsIn ? MIGRATIONS_TOML : ''}`
    );
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: `@authrim/${component}`, version: '1.0.0' })
    );
  }
  return dir;
}

type Event = { kind: 'direct-deploy' | 'upload' | 'promote'; component: string };

function installExecaMock(
  events: Event[],
  behavior: {
    failDirectDeploy?: string[];
    failPromotionSpec?: string;
    onTriggerValidation?: () => void;
  } = {}
): void {
  vi.mocked(execa).mockImplementation((async (
    _command: string,
    args: string[],
    options?: { cwd?: unknown; env?: Record<string, string> }
  ) => {
    const commandArgs = [...(args ?? [])];
    const component = basename(String(options?.cwd));
    const ok = {
      exitCode: 0,
      stdout: JSON.stringify({ type: 'deploy', version_id: VERSION_ID }),
      stderr: '',
    };
    if (commandArgs.includes('versions') && commandArgs.includes('upload')) {
      events.push({ kind: 'upload', component });
      writeFileSync(
        join(String(options?.env?.WRANGLER_OUTPUT_FILE_DIRECTORY), 'wrangler-output.ndjson'),
        `${JSON.stringify({ type: 'version-upload', version_id: `new-${component}` })}\n`
      );
    } else if (commandArgs.includes('versions') && commandArgs.includes('deploy')) {
      events.push({ kind: 'promote', component });
      if (behavior.failPromotionSpec && commandArgs.includes(behavior.failPromotionSpec)) {
        throw Object.assign(new Error('400 invalid deployment'), {
          stderr: '400 invalid deployment',
          exitCode: 1,
        });
      }
    } else if (commandArgs.includes('triggers')) {
      behavior.onTriggerValidation?.();
    } else if (commandArgs.includes('deployments') && commandArgs.includes('list')) {
      return {
        ...ok,
        stdout: JSON.stringify([
          {
            id: `baseline-${component}`,
            versions: [{ version_id: `old-${component}`, percentage: 100 }],
          },
        ]),
      };
    } else if (commandArgs[2] === 'deploy' || commandArgs.includes('deploy')) {
      if (!commandArgs.includes('versions') && !commandArgs.includes('triggers')) {
        events.push({ kind: 'direct-deploy', component });
        if (behavior.failDirectDeploy?.includes(component)) {
          throw Object.assign(new Error('400 invalid migration'), {
            stderr: '400 invalid migration',
            exitCode: 1,
          });
        }
      }
    }
    return ok;
  }) as never);
}

function deployAll(
  rootDir: string,
  overrides: Partial<DeployOptions> = {},
  components: Parameters<typeof deployAllCore>[1] = ['ar-lib-core', 'ar-token']
) {
  return deployAllCore(
    {
      env: 'test',
      rootDir,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-lib-core', 'ar-token'],
      readAvailableDiskBytes: async () => 2 * 1024 * 1024 * 1024,
      workerScriptOwnership: ownership,
      maxRetries: 1,
      retryDelayMs: 1,
      ...overrides,
    },
    components
  );
}

beforeEach(() => {
  vi.mocked(execa).mockReset();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('deployAll staged order with pending Durable Object migrations', () => {
  it('deploys a Worker with pending migrations directly before any versioned upload', async () => {
    const rootDir = createRoot();
    const events: Event[] = [];
    installExecaMock(events);
    const readWorkerMigrationState = vi.fn(async () => ({
      exists: true as const,
      migrationTag: 'v1',
    }));

    const summary = await deployAll(rootDir, { readWorkerMigrationState });

    expect(summary.failedCount).toBe(0);
    expect(readWorkerMigrationState).toHaveBeenCalledTimes(1);
    expect(readWorkerMigrationState).toHaveBeenCalledWith('test-ar-lib-core', undefined);
    expect(events.map((event) => `${event.kind}:${event.component}`)).toEqual([
      'direct-deploy:ar-lib-core',
      'upload:ar-token',
      'promote:ar-token',
    ]);
  });

  it('reports the early direct deployment exactly once and never deploys it again', async () => {
    const rootDir = createRoot();
    const events: Event[] = [];
    installExecaMock(events);

    const summary = await deployAll(rootDir, {
      readWorkerMigrationState: async () => ({ exists: true, migrationTag: 'v1' }),
    });

    expect(events.filter((event) => event.component === 'ar-lib-core')).toHaveLength(1);
    expect(summary.results.map((result) => result.component)).toEqual(['ar-lib-core', 'ar-token']);
    expect(summary.results.filter((result) => result.component === 'ar-lib-core')).toHaveLength(1);
    expect(summary.successCount).toBe(2);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({ success: true, cloudflareVersionId: VERSION_ID })
    );
  });

  it('treats a script that never recorded a migration tag as pending', async () => {
    const rootDir = createRoot();
    const events: Event[] = [];
    installExecaMock(events);

    await deployAll(rootDir, { readWorkerMigrationState: async () => ({ exists: true }) });

    expect(events[0]).toEqual({ kind: 'direct-deploy', component: 'ar-lib-core' });
  });

  it('keeps the old order when the deployed migration tag is already current', async () => {
    const rootDir = createRoot();
    const events: Event[] = [];
    installExecaMock(events);

    const summary = await deployAll(rootDir, {
      readWorkerMigrationState: async () => ({ exists: true, migrationTag: 'v2' }),
    });

    expect(summary.failedCount).toBe(0);
    expect(events.map((event) => `${event.kind}:${event.component}`)).toEqual([
      'upload:ar-token',
      'direct-deploy:ar-lib-core',
      'promote:ar-token',
    ]);
  });

  it('keeps the old order and says so when the deployed migration tag cannot be read', async () => {
    const rootDir = createRoot();
    const events: Event[] = [];
    const messages: string[] = [];
    installExecaMock(events);

    const summary = await deployAll(rootDir, {
      readWorkerMigrationState: async () => {
        throw new Error('Cloudflare API returned HTTP 500');
      },
      onProgress: (message) => messages.push(message),
    });

    expect(summary.failedCount).toBe(0);
    expect(events[0]).toEqual({ kind: 'upload', component: 'ar-token' });
    expect(messages.join('\n')).toContain(
      'Could not read the deployed Durable Object migration tag'
    );
  });

  it('uploads nothing and reports a clear failure when the early direct deployment fails', async () => {
    const rootDir = createRoot();
    const events: Event[] = [];
    installExecaMock(events, { failDirectDeploy: ['ar-lib-core'] });

    const summary = await deployAll(rootDir, {
      readWorkerMigrationState: async () => ({ exists: true, migrationTag: 'v1' }),
    });

    expect(events.some((event) => event.kind === 'upload' || event.kind === 'promote')).toBe(false);
    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(2);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({ component: 'ar-lib-core', success: false })
    );
    expect(summary.results[1].error).toContain(
      'Durable Object migration deployment of ar-lib-core failed'
    );
  });

  it('does not touch the provider when a deployment context fails validation', async () => {
    const rootDir = createRoot();
    rmSync(join(rootDir, 'packages', 'ar-token', 'wrangler.toml'));
    const events: Event[] = [];
    installExecaMock(events);
    const readWorkerMigrationState = vi.fn(async () => ({
      exists: true as const,
      migrationTag: 'v1',
    }));

    const summary = await deployAll(rootDir, { readWorkerMigrationState });

    expect(summary.failedCount).toBeGreaterThan(0);
    expect(readWorkerMigrationState).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === 'direct-deploy')).toBe(false);
  });

  it('announces the early direct deployment in a dry run without deploying', async () => {
    const rootDir = createRoot();
    const messages: string[] = [];

    const summary = await deployAll(rootDir, {
      dryRun: true,
      readWorkerMigrationState: async () => ({ exists: true, migrationTag: 'v1' }),
      onProgress: (message) => messages.push(message),
    });

    expect(summary.failedCount).toBe(0);
    expect(execa).not.toHaveBeenCalled();
    const output = messages.join('\n');
    expect(output).toContain(
      'Would deploy ar-lib-core directly BEFORE uploading other Worker versions because it has pending Durable Object migrations'
    );
    expect(output).toContain('Would upload and promote ar-token');
  });
});

describe('deployAll early direct deployment bookkeeping', () => {
  it('keeps the early result when another promotion fails before its scheduler slot', async () => {
    // ar-token carries the pending migration and depends on ar-lib-core, whose promotion fails.
    // The scheduler (concurrency 1) halts before reaching ar-token.
    const rootDir = createRoot('ar-token');
    const events: Event[] = [];
    installExecaMock(events, { failPromotionSpec: 'new-ar-lib-core@100%' });

    const summary = await deployAll(rootDir, {
      concurrency: 1,
      readWorkerMigrationState: async () => ({ exists: true, migrationTag: 'v1' }),
    });

    expect(events[0]).toEqual({ kind: 'direct-deploy', component: 'ar-token' });
    expect(events.filter((event) => event.component === 'ar-token')).toHaveLength(1);
    const early = summary.results.find((result) => result.component === 'ar-token');
    expect(early).toEqual(
      expect.objectContaining({ success: true, cloudflareVersionId: VERSION_ID })
    );
    expect(early?.error).toBeUndefined();
    expect(summary.results.find((result) => result.component === 'ar-lib-core')?.success).toBe(
      false
    );
  });

  it('stops before promotion and still returns the summary when the early deployment lease is taken over', async () => {
    const rootDir = createRoot('ar-lib-core');
    const events: Event[] = [];
    const state = { lost: false };
    const completions: Array<[boolean, string | undefined]> = [];
    installExecaMock(events, { onTriggerValidation: () => (state.lost = true) });
    const lease = (workerScriptName: string, fencingToken = 1) => ({
      environmentId: 'test',
      workerScriptName,
      operationId: 'op-test',
      fencingToken,
      leaseExpiresAt: 1_000,
      expectedSourceVersionId: 'old',
      mutationStarted: false,
    });
    const coordinator = {
      acquire: async ({ workerScriptName }: { workerScriptName: string }) =>
        lease(workerScriptName),
      renew: async (held: ReturnType<typeof lease>) => {
        if (state.lost) throw new Error('lease_lost');
        return held;
      },
      assertCurrent: async () => {
        if (state.lost) throw new Error('lease_lost');
      },
      markMutationStarted: async (held: ReturnType<typeof lease>) => ({
        ...held,
        mutationStarted: true,
      }),
      // Once the lease is lost another operation owns it: release reports the takeover.
      release: async () => (state.lost ? ('taken_over' as const) : ('released' as const)),
      complete: async (success: boolean, errorCode?: string) => {
        completions.push([success, errorCode]);
      },
    };

    const summary = await deployAll(rootDir, {
      readWorkerMigrationState: async () => ({ exists: true, migrationTag: 'v1' }),
      deploymentLease: {
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        environmentId: 'test',
        actorId: 'setup:test',
        required: true,
        coordinator,
      },
    });

    expect(events.map((event) => `${event.kind}:${event.component}`)).toEqual([
      'direct-deploy:ar-lib-core',
      'upload:ar-token',
    ]);
    // The takeover must not turn into a thrown release error: the summary of the live Worker is
    // returned and the session is completed as failed.
    expect(completions).toEqual([[false, 'deployment_lease_lost']]);
    expect(summary.successCount).toBe(0);
    const early = summary.results.find((result) => result.component === 'ar-lib-core');
    expect(early).toEqual(
      expect.objectContaining({
        success: false,
        trafficCommitted: true,
        cloudflareVersionId: VERSION_ID,
      })
    );
    expect(early?.error).toContain('Deployment lease for test-ar-lib-core could not be verified');
    expect(early?.error).toContain('no version was promoted');
    expect(summary.results.find((result) => result.component === 'ar-token')?.error).toContain(
      'not promoted because the deployment lease of ar-lib-core could not be verified'
    );
  });
});

describe('deployAll lease takeover detected only at close', () => {
  it('reports every leased Worker as failed (keeping its version id) when release finds a takeover', async () => {
    const rootDir = createRoot('ar-lib-core');
    const events: Event[] = [];
    installExecaMock(events);
    const completions: Array<[boolean, string | undefined]> = [];
    const lease = (workerScriptName: string) => ({
      environmentId: 'test',
      workerScriptName,
      operationId: 'op-test',
      fencingToken: 1,
      leaseExpiresAt: 1_000,
      expectedSourceVersionId: 'old',
      mutationStarted: false,
    });
    type Lease = ReturnType<typeof lease>;
    const coordinator = {
      acquire: async ({ workerScriptName }: { workerScriptName: string }) =>
        lease(workerScriptName),
      renew: async (held: Lease) => held,
      assertCurrent: async () => undefined,
      markMutationStarted: async (held: Lease) => ({ ...held, mutationStarted: true }),
      // Every deployment step succeeds; the takeover only becomes visible when releasing.
      release: async () => 'taken_over' as const,
      complete: async (success: boolean, errorCode?: string) => {
        completions.push([success, errorCode]);
      },
    };
    const messages: string[] = [];

    const summary = await deployAll(rootDir, {
      readWorkerMigrationState: async () => ({ exists: true, migrationTag: 'v1' }),
      deploymentLease: {
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        environmentId: 'test',
        actorId: 'setup:test',
        required: true,
        coordinator,
      },
      onProgress: (message) => messages.push(message),
    });

    expect(events.map((event) => `${event.kind}:${event.component}`)).toEqual([
      'direct-deploy:ar-lib-core',
      'upload:ar-token',
      'promote:ar-token',
    ]);
    expect(completions).toEqual([[false, 'deployment_lease_lost']]);
    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(2);
    for (const result of summary.results) {
      expect(result).toEqual(expect.objectContaining({ success: false, trafficCommitted: true }));
      expect(result.error).toContain('deployment lease was taken over by another operation');
    }
    expect(summary.results[0].cloudflareVersionId).toBe(VERSION_ID);
    expect(messages.join('\n')).toContain('Failed: 2');
  });
});

describe('lease takeover for callers that do not opt in to reporting it', () => {
  it('still throws when releasing a taken-over lease (legacy secret cleanup)', async () => {
    const rootDir = createRoot();
    const packageDir = join(rootDir, 'packages', 'ar-auth');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'wrangler.toml'), 'name = "test-ar-auth"\n');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: '@authrim/ar-auth', version: '1.0.0' })
    );
    installExecaMock([]);
    const completions: Array<[boolean, string | undefined]> = [];
    const lease = (workerScriptName: string) => ({
      environmentId: 'test',
      workerScriptName,
      operationId: 'op-test',
      fencingToken: 1,
      leaseExpiresAt: 1_000,
      expectedSourceVersionId: 'old',
      mutationStarted: false,
    });
    type Lease = ReturnType<typeof lease>;

    await expect(
      cleanupLegacyStaticSecrets(
        {
          env: 'test',
          rootDir,
          existingComponents: ['ar-auth'],
          deploymentLease: {
            controlDatabaseId: '11111111-1111-1111-1111-111111111111',
            environmentId: 'test',
            actorId: 'setup:test',
            required: true,
            coordinator: {
              acquire: async ({ workerScriptName }) => lease(workerScriptName),
              renew: async (held: Lease) => held,
              assertCurrent: async () => undefined,
              markMutationStarted: async (held: Lease) => ({ ...held, mutationStarted: true }),
              release: async () => 'taken_over' as const,
              complete: async (success: boolean, errorCode?: string) => {
                completions.push([success, errorCode]);
              },
            },
          },
        },
        ['ar-auth']
      )
    ).rejects.toThrow('worker_deployment_lease_release_failed');
    expect(completions).toEqual([[false, 'deployment_lease_release_failed']]);
  });
});

describe('classifyDurableObjectMigrations', () => {
  it('reports none when the config has no migrations', () => {
    expect(classifyDurableObjectMigrations([], { exists: true, migrationTag: 'v1' })).toBe('none');
  });

  it('reports current when the deployed tag is the last config tag', () => {
    expect(
      classifyDurableObjectMigrations(['v1', 'v2'], { exists: true, migrationTag: 'v2' })
    ).toBe('current');
  });

  it('reports pending when the deployed tag is older, unlisted, or missing', () => {
    expect(
      classifyDurableObjectMigrations(['v1', 'v2'], { exists: true, migrationTag: 'v1' })
    ).toBe('pending');
    expect(
      classifyDurableObjectMigrations(['v1', 'v2'], { exists: true, migrationTag: 'v9' })
    ).toBe('pending');
    expect(classifyDurableObjectMigrations(['v1', 'v2'], { exists: true })).toBe('pending');
  });

  it('reports absent for a missing script and unknown when the remote state is unavailable', () => {
    expect(classifyDurableObjectMigrations(['v1'], { exists: false })).toBe('absent');
    expect(classifyDurableObjectMigrations(['v1'], undefined)).toBe('unknown');
  });
});

describe('parseWranglerMigrationTags', () => {
  it('returns the ordered tags of top-level migration tables only', () => {
    expect(
      parseWranglerMigrationTags(
        [
          'name = "x"',
          'tag = "not-a-migration"',
          '[[migrations]]',
          'tag = "v1"',
          'new_sqlite_classes = [',
          '  "A",',
          ']',
          '[[migrations]] # second',
          'tag="v2" # note',
          '[[env.test.migrations]]',
          'tag = "env-scoped"',
          '[env.test]',
          'tag = "also-not"',
        ].join('\n')
      )
    ).toEqual(['v1', 'v2']);
  });

  it('returns no tags without migrations', () => {
    expect(parseWranglerMigrationTags('name = "x"\n')).toEqual([]);
  });
});
