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
  detectEnvironments: vi.fn(),
  deleteEnvironment: vi.fn(),
  hasControlManagedResourcesForEnvironment: vi.fn(),
  cleanupLocalEnvironmentArtifacts: vi.fn(),
  findAuthrimBaseDir: vi.fn(),
  acquireEnvironmentOperationForEnvironment: vi.fn(),
  evaluateEnvironmentOperation: vi.fn(),
  reconcileLockAfterResourceDeletion: vi.fn((lock) => lock),
  saveLockFile: vi.fn(),
  release: vi.fn(),
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
  detectEnvironments: mocks.detectEnvironments,
  deleteEnvironment: mocks.deleteEnvironment,
  hasControlManagedResourcesForEnvironment: mocks.hasControlManagedResourcesForEnvironment,
}));

vi.mock('../core/environment-cleanup.js', () => ({
  cleanupLocalEnvironmentArtifacts: mocks.cleanupLocalEnvironmentArtifacts,
}));

vi.mock('../core/paths.js', () => ({
  findAuthrimBaseDir: mocks.findAuthrimBaseDir,
}));

vi.mock('../core/lock.js', () => ({
  acquireEnvironmentOperationForEnvironment: mocks.acquireEnvironmentOperationForEnvironment,
  reconcileLockAfterResourceDeletion: mocks.reconcileLockAfterResourceDeletion,
  saveLockFile: mocks.saveLockFile,
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
    mocks.hasControlManagedResourcesForEnvironment.mockResolvedValue(false);
    mocks.findAuthrimBaseDir.mockReturnValue('/workspace');
    mocks.acquireEnvironmentOperationForEnvironment.mockResolvedValue({
      lock: null,
      release: mocks.release,
    });
    mocks.evaluateEnvironmentOperation.mockReturnValue({ allowed: true });
    mocks.cleanupLocalEnvironmentArtifacts.mockResolvedValue({ errors: [] });
  });

  it('reports a large R2 cleanup as a manual action instead of an error', async () => {
    mocks.deleteEnvironment.mockResolvedValue({
      success: true,
      completion: 'manual_action_required',
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
      expect(mocks.cleanupLocalEnvironmentArtifacts).toHaveBeenCalledOnce();
      expect(mocks.release).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('uses the selected locale for prerequisite status messages', async () => {
    await setLocale('ja');
    mocks.deleteEnvironment.mockResolvedValue({
      success: true,
      completion: 'complete',
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

  it('preserves local environment state when Cloudflare deletion has real errors', async () => {
    mocks.deleteEnvironment.mockResolvedValue({
      success: false,
      completion: 'failed',
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
