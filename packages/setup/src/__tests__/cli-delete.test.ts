import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockSpinner = {
  text: string;
  isSpinning: boolean;
  start: ReturnType<typeof vi.fn>;
  succeed: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  isWranglerInstalled: vi.fn(),
  checkAuth: vi.fn(),
  confirmEnvironmentObservedForDeletion: vi.fn(),
  detectEnvironments: vi.fn(),
  deleteEnvironment: vi.fn(),
  cleanupLocalEnvironmentArtifacts: vi.fn(),
  inspectLocalEnvironmentState: vi.fn(),
  findAuthrimBaseDir: vi.fn(),
  acquireDeployConfigLock: vi.fn(),
  acquireEnvironmentOperationForEnvironment: vi.fn(),
  evaluateEnvironmentOperation: vi.fn(),
  reconcileLockAfterResourceDeletion: vi.fn((lock) => lock),
  collectWorkerDeletionIdentities: vi.fn((lock) => {
    const byComponent = new Map(Object.entries(lock.workers ?? {}));
    for (const [component, checkpoint] of Object.entries(lock.workerScriptOwnership ?? {}) as Array<
      [string, Record<string, string>]
    >) {
      byComponent.set(
        component,
        checkpoint.state === 'provisional'
          ? { name: checkpoint.name, cloudflareScriptTag: checkpoint.cloudflareScriptTag }
          : {
              name: checkpoint.name,
              cloudflareVersionId: checkpoint.pendingCloudflareVersionId,
              cloudflareVersionState: 'uploaded',
            }
      );
    }
    return Array.from(byComponent.values());
  }),
  withBackfilledWorkerDeletionIdentities: vi.fn((lock) => lock),
  saveLockFile: vi.fn(),
  release: vi.fn(),
  deployConfigRelease: vi.fn(),
  cleanupSetupManagedControlTokens: vi.fn(),
  reconcileLegacyQueueIdentitiesForDeletion: vi.fn(),
  oraSpinners: [] as MockSpinner[],
}));

vi.mock('ora', () => ({
  default: vi.fn(() => {
    const spinner = {
      text: '',
      isSpinning: true,
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      warn: vi.fn(),
    };
    spinner.start.mockReturnValue(spinner);
    mocks.oraSpinners.push(spinner);
    return spinner;
  }),
}));

vi.mock('../core/cloudflare.js', () => ({
  isWranglerInstalled: mocks.isWranglerInstalled,
  checkAuth: mocks.checkAuth,
  confirmEnvironmentObservedForDeletion: mocks.confirmEnvironmentObservedForDeletion,
  detectEnvironments: mocks.detectEnvironments,
  deleteEnvironment: mocks.deleteEnvironment,
}));

vi.mock('../core/environment-cleanup.js', () => ({
  cleanupLocalEnvironmentArtifacts: mocks.cleanupLocalEnvironmentArtifacts,
}));

vi.mock('../core/control-token-environment-cleanup.js', () => ({
  cleanupSetupManagedControlTokens: mocks.cleanupSetupManagedControlTokens,
}));

vi.mock('../core/legacy-queue-identity-deletion.js', () => ({
  reconcileLegacyQueueIdentitiesForDeletion: mocks.reconcileLegacyQueueIdentitiesForDeletion,
}));

vi.mock('../core/local-environment-state.js', () => ({
  inspectLocalEnvironmentState: mocks.inspectLocalEnvironmentState,
}));

vi.mock('../core/paths.js', () => ({
  findAuthrimBaseDir: mocks.findAuthrimBaseDir,
}));

vi.mock('../core/lock.js', () => ({
  acquireDeployConfigLock: mocks.acquireDeployConfigLock,
  acquireEnvironmentOperationForEnvironment: mocks.acquireEnvironmentOperationForEnvironment,
  reconcileLockAfterResourceDeletion: mocks.reconcileLockAfterResourceDeletion,
  collectWorkerDeletionIdentities: mocks.collectWorkerDeletionIdentities,
  saveLockFile: mocks.saveLockFile,
  withBackfilledWorkerDeletionIdentities: mocks.withBackfilledWorkerDeletionIdentities,
}));

vi.mock('../core/environment-operation-policy.js', () => ({
  evaluateEnvironmentOperation: mocks.evaluateEnvironmentOperation,
  environmentOperationBlockMessage: vi.fn(() => 'blocked'),
}));

import { deleteCommand } from '../cli/commands/delete.js';
import { initI18n, setLocale } from '../i18n/index.js';

describe('CLI environment deletion', () => {
  beforeEach(async () => {
    await initI18n('en');
    vi.clearAllMocks();
    mocks.oraSpinners.length = 0;
    mocks.isWranglerInstalled.mockResolvedValue(true);
    mocks.checkAuth.mockResolvedValue({ isLoggedIn: true, email: 'operator@example.com' });
    mocks.detectEnvironments.mockResolvedValue([
      { env: 'test', workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
    ]);
    mocks.confirmEnvironmentObservedForDeletion.mockResolvedValue(true);
    mocks.findAuthrimBaseDir.mockReturnValue('/workspace');
    mocks.acquireEnvironmentOperationForEnvironment.mockResolvedValue({
      lock: null,
      release: mocks.release,
    });
    mocks.acquireDeployConfigLock.mockResolvedValue({
      path: '/workspace/.authrim/deploy-config.operation-lock',
      release: mocks.deployConfigRelease,
    });
    mocks.evaluateEnvironmentOperation.mockReturnValue({ allowed: true });
    mocks.cleanupLocalEnvironmentArtifacts.mockResolvedValue({ errors: [] });
    mocks.cleanupSetupManagedControlTokens.mockResolvedValue({
      status: 'completed',
      revokedTokenIds: [],
      alreadyAbsentTokenIds: [],
    });
    mocks.reconcileLegacyQueueIdentitiesForDeletion.mockImplementation(async ({ lock }) => ({
      lock,
      adopted: [],
    }));
    mocks.inspectLocalEnvironmentState.mockReturnValue({ exists: false, paths: [] });
  });

  it('deletes config-and-intent-only interrupted provisioning state', async () => {
    mocks.inspectLocalEnvironmentState.mockReturnValue({
      exists: true,
      paths: [
        '/workspace/.authrim/test/config.json',
        '/workspace/.authrim/test/provisioning-intent.json',
      ],
    });
    mocks.confirmEnvironmentObservedForDeletion.mockResolvedValue(false);
    mocks.deleteEnvironment.mockResolvedValue({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      errors: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({ env: 'test', yes: true, all: true });
      expect(mocks.evaluateEnvironmentOperation).toHaveBeenCalledWith(
        expect.objectContaining({ environmentKnownLocally: true })
      );
      expect(mocks.deleteEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ env: 'test', environmentKnownLocally: true })
      );
      expect(mocks.cleanupLocalEnvironmentArtifacts).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('reports a large R2 cleanup as a manual action instead of an error', async () => {
    mocks.deleteEnvironment.mockResolvedValue({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: false,
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [
        {
          bucketName: 'test-diagnostic-logs',
          objectCount: 5_214,
          dashboardUrl:
            'https://dash.cloudflare.com/example/r2/default/buckets/test-diagnostic-logs',
        },
      ],
      errors: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({ env: 'test', yes: true, all: true });
      expect(
        mocks.oraSpinners.some((spinner) =>
          spinner.warn.mock.calls.some(([message]) =>
            String(message).includes('R2 cleanup requires a manual action')
          )
        )
      ).toBe(true);
      expect(log.mock.calls.flat().join('\n')).toContain(
        'Complete the R2 actions above to finish cleanup.'
      );
      expect(mocks.cleanupLocalEnvironmentArtifacts).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('wires setup-managed token cleanup to the exact lock-recorded Control D1 boundary', async () => {
    mocks.acquireEnvironmentOperationForEnvironment.mockResolvedValueOnce({
      lock: {
        env: 'test',
        d1: { CONTROL_DB: { id: 'control-id', name: 'test-authrim-control-db' } },
        kv: {},
        workers: {
          'ar-auth': { name: 'test-ar-auth', cloudflareScriptTag: 'auth-worker-tag' },
        },
      },
      lockFilePath: '/workspace/.authrim/test/lock.json',
      release: mocks.release,
    });
    mocks.deleteEnvironment.mockImplementationOnce(async (options) => {
      await options.beforeD1Deletion?.({
        observedD1Resources: [{ id: 'control-id', name: 'test-authrim-control-db' }],
      });
      return {
        success: true,
        completion: 'complete',
        environmentEmpty: false,
        deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
        manualR2: [],
        errors: [],
      };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({ env: 'test', yes: true, all: true });
      expect(mocks.deleteEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          knownD1Resources: [{ id: 'control-id', name: 'test-authrim-control-db' }],
          knownWorkerResources: [{ name: 'test-ar-auth', cloudflareScriptTag: 'auth-worker-tag' }],
          knownKVResources: [],
          knownQueueResources: [],
        })
      );
      expect(mocks.cleanupSetupManagedControlTokens).toHaveBeenCalledWith({
        baseDir: '/workspace',
        environment: 'test',
        controlDatabaseIdentifier: 'control-id',
      });
    } finally {
      log.mockRestore();
    }
  });

  it('uses a pending Worker Version ID checkpoint for verified deletion recovery', async () => {
    mocks.acquireEnvironmentOperationForEnvironment.mockResolvedValueOnce({
      lock: {
        env: 'test',
        d1: {},
        kv: {},
        workers: {},
        workerScriptOwnership: {
          'ar-auth': {
            name: 'test-ar-auth',
            pendingCloudflareVersionId: '11111111-1111-4111-8111-111111111111',
            state: 'pending_tag',
            updatedAt: '2026-09-02T00:00:00.000Z',
          },
        },
      },
      lockFilePath: '/workspace/.authrim/test/lock.json',
      release: mocks.release,
    });
    mocks.deleteEnvironment.mockResolvedValueOnce({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      deleted: { workers: ['test-ar-auth'], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      errors: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({ env: 'test', yes: true, all: true });
      expect(mocks.deleteEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          knownWorkerResources: [
            {
              name: 'test-ar-auth',
              cloudflareVersionId: '11111111-1111-4111-8111-111111111111',
              cloudflareVersionState: 'uploaded',
            },
          ],
        })
      );
      expect(log.mock.calls.flat().join('\n')).toContain('unfinished Worker ownership checkpoint');
    } finally {
      log.mockRestore();
    }
  });

  it('passes an atomically upgraded legacy Queue identity to deletion', async () => {
    const queueName = 'test-audit-queue';
    const lock = {
      env: 'test',
      d1: {},
      kv: {},
      workers: {},
      queues: { AUDIT_QUEUE: { id: queueName, name: queueName } },
    };
    const upgradedLock = {
      ...lock,
      queues: { AUDIT_QUEUE: { id: 'queue-provider-id', name: queueName } },
    };
    mocks.acquireEnvironmentOperationForEnvironment.mockResolvedValueOnce({
      lock,
      lockFilePath: '/workspace/.authrim/test/lock.json',
      release: mocks.release,
    });
    mocks.reconcileLegacyQueueIdentitiesForDeletion.mockResolvedValueOnce({
      lock: upgradedLock,
      adopted: [
        {
          binding: 'AUDIT_QUEUE',
          name: queueName,
          previousId: queueName,
          providerId: 'queue-provider-id',
        },
      ],
    });
    mocks.deleteEnvironment.mockResolvedValueOnce({
      success: true,
      completion: 'complete',
      environmentEmpty: false,
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      errors: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({ env: 'test', yes: true, all: true });
      expect(mocks.reconcileLegacyQueueIdentitiesForDeletion).toHaveBeenCalledWith({
        lock,
        environment: 'test',
        config: null,
        lockFilePath: '/workspace/.authrim/test/lock.json',
      });
      expect(mocks.deleteEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          knownQueueResources: [{ id: 'queue-provider-id', name: queueName }],
        })
      );
    } finally {
      log.mockRestore();
    }
  });

  it('does not query a same-name replacement Control D1 during token cleanup', async () => {
    mocks.acquireEnvironmentOperationForEnvironment.mockResolvedValueOnce({
      lock: {
        env: 'test',
        d1: { CONTROL_DB: { id: 'control-id', name: 'test-authrim-control-db' } },
        kv: {},
      },
      lockFilePath: '/workspace/.authrim/test/lock.json',
      release: mocks.release,
    });
    mocks.deleteEnvironment.mockImplementationOnce(async (options) => {
      await options.beforeD1Deletion?.({
        observedD1Resources: [{ id: 'replacement-control-id', name: 'test-authrim-control-db' }],
      });
      return {
        success: true,
        completion: 'complete',
        environmentEmpty: false,
        deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
        manualR2: [],
        errors: [],
      };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({ env: 'test', yes: true, all: true });
      expect(mocks.cleanupSetupManagedControlTokens).toHaveBeenCalledWith({
        baseDir: '/workspace',
        environment: 'test',
        controlDatabaseIdentifier: null,
      });
    } finally {
      log.mockRestore();
    }
  });

  it('uses the selected locale for prerequisite status messages', async () => {
    await setLocale('ja');
    mocks.deleteEnvironment.mockResolvedValue({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      errors: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({ env: 'test', yes: true, all: true });
      expect(mocks.oraSpinners[0]?.succeed).toHaveBeenCalledWith(
        'Cloudflareに接続しました (operator@example.com)'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('fails the active deletion spinner and releases the lock on an unexpected error', async () => {
    mocks.deleteEnvironment.mockRejectedValue(new Error('Cloudflare request failed'));

    await expect(deleteCommand({ env: 'test', yes: true, all: true })).rejects.toThrow(
      'Cloudflare request failed'
    );
    expect(
      mocks.oraSpinners.some((spinner) =>
        spinner.fail.mock.calls.some(([message]) =>
          String(message).includes('Environment deletion failed unexpectedly')
        )
      )
    ).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('explains that deletion did not start when inventory verification fails', async () => {
    mocks.deleteEnvironment.mockRejectedValue(
      Object.assign(new Error('No resources were deleted'), {
        code: 'environment_inventory_unavailable',
      })
    );

    await expect(deleteCommand({ env: 'test', yes: true, all: true })).rejects.toThrow(
      'No resources were deleted'
    );
    expect(
      mocks.oraSpinners.some((spinner) =>
        spinner.fail.mock.calls.some(([message]) =>
          String(message).includes(
            'Deletion did not start because Cloudflare resource inventory could not be verified'
          )
        )
      )
    ).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('localizes a no-lock inventory failure before deletion starts', async () => {
    await setLocale('ja');
    mocks.confirmEnvironmentObservedForDeletion.mockRejectedValue(
      Object.assign(new Error('No resources were deleted'), {
        code: 'environment_inventory_unavailable',
      })
    );

    await expect(deleteCommand({ env: 'test', yes: true, all: true })).rejects.toThrow(
      'No resources were deleted'
    );
    expect(mocks.deleteEnvironment).not.toHaveBeenCalled();
    expect(
      mocks.oraSpinners.some((spinner) =>
        spinner.fail.mock.calls.some(([message]) =>
          String(message).includes(
            'Cloudflareのリソース一覧を確認できなかったため、削除を開始しませんでした'
          )
        )
      )
    ).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('preserves local environment state when Cloudflare deletion has real errors', async () => {
    mocks.deleteEnvironment.mockResolvedValue({
      success: false,
      completion: 'failed',
      environmentEmpty: false,
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      errors: ['Failed to delete Worker: test-ar-auth'],
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(deleteCommand({ env: 'test', yes: true, all: true })).rejects.toThrow(
        'process.exit:1'
      );
      expect(mocks.cleanupLocalEnvironmentArtifacts).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  it('reports retryable post-delete verification without cleaning local state', async () => {
    mocks.deleteEnvironment.mockResolvedValue({
      success: false,
      completion: 'failed',
      environmentEmpty: false,
      retryable: true,
      postDeleteVerification: 'resources_remaining',
      deleted: { workers: [], d1: [], kv: [], queues: [], r2: [], pages: [] },
      manualR2: [],
      errors: ['Cloudflare resources still remain; retry deletion.'],
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(deleteCommand({ env: 'test', yes: true, all: true })).rejects.toThrow(
        'process.exit:1'
      );
      expect(log.mock.calls.flat().join('\n')).toContain(
        'Local recovery state was preserved; retry the same delete command.'
      );
      expect(mocks.cleanupLocalEnvironmentArtifacts).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  it('preserves local environment state when resource types are intentionally retained', async () => {
    const lock = {
      env: 'test',
      d1: { CORE_DB: { id: 'core-id', name: 'test-authrim-core-db' } },
      kv: {},
      workers: { 'ar-auth': { name: 'test-ar-auth' } },
    };
    mocks.acquireEnvironmentOperationForEnvironment.mockResolvedValueOnce({
      lock,
      lockFilePath: '/workspace/.authrim/test/lock.json',
      release: mocks.release,
    });
    mocks.deleteEnvironment.mockResolvedValue({
      success: true,
      completion: 'complete',
      environmentEmpty: false,
      deleted: {
        workers: ['test-ar-auth'],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [],
      },
      manualR2: [],
      errors: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({
        env: 'test',
        yes: true,
        workers: true,
        d1: false,
        kv: false,
        queues: false,
        r2: false,
        pages: false,
      });

      expect(mocks.cleanupLocalEnvironmentArtifacts).not.toHaveBeenCalled();
      expect(mocks.reconcileLockAfterResourceDeletion).toHaveBeenCalledWith(
        lock,
        expect.objectContaining({ workers: ['test-ar-auth'] })
      );
      expect(mocks.saveLockFile).toHaveBeenCalledWith(lock, '/workspace/.authrim/test/lock.json');
      expect(mocks.deleteEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ deletePages: false })
      );
      expect(
        mocks.oraSpinners.some((spinner) =>
          spinner.succeed.mock.calls.some(([message]) =>
            String(message).includes(
              'Selected resources deleted; remaining environment state was preserved'
            )
          )
        )
      ).toBe(true);
      expect(log.mock.calls.flat().join('\n')).toContain(
        'Selected resources deleted; remaining environment state was preserved'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('writes progress lines when ora animations are disabled in a non-TTY process', async () => {
    mocks.deleteEnvironment.mockImplementation(async (options) => {
      const deleteSpinner = mocks.oraSpinners.at(-1)!;
      deleteSpinner.isSpinning = false;
      options.onProgress?.('⏳ Deleting: test-ar-auth...');
      options.onResourceProgress?.({ current: 1, total: 1 });
      return {
        success: true,
        completion: 'complete',
        environmentEmpty: true,
        deleted: {
          workers: ['test-ar-auth'],
          d1: [],
          kv: [],
          queues: [],
          r2: [],
          pages: [],
        },
        manualR2: [],
        errors: [],
      };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await deleteCommand({ env: 'test', yes: true, all: true });
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('Deleting: test-ar-auth...');
      expect(output).toContain('Deleting environment resources (1/1)...');
    } finally {
      log.mockRestore();
    }
  });
});
