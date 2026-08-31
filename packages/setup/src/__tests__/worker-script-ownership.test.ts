import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthrimLock } from '../core/lock.js';
import { saveLockFile } from '../core/lock.js';
import {
  prepareManagedWorkerScriptOwnership,
  prepareWorkerScriptOwnership,
} from '../core/worker-script-ownership.js';

const VERSION_A = '00000000-0000-4000-8000-000000000001';
const VERSION_B = '00000000-0000-4000-8000-000000000002';
const TAG_A = '11111111111111111111111111111111';
const TAG_B = '22222222222222222222222222222222';

function lockWithWorker(
  worker?: Partial<NonNullable<AuthrimLock['workers']>[string]>
): AuthrimLock {
  return {
    version: '1.0.0',
    createdAt: '2026-08-31T00:00:00.000Z',
    env: 'test',
    d1: {},
    kv: {},
    workers: worker
      ? {
          'ar-auth': {
            name: 'test-ar-auth',
            deployedAt: '2026-08-31T00:00:00.000Z',
            version: '0.4.0',
            cloudflareVersionId: VERSION_A,
            ...worker,
          },
        }
      : {},
  };
}

const TARGET = [{ component: 'ar-auth', workerName: 'test-ar-auth' }] as const;

describe('Worker script immutable ownership', () => {
  it('blocks a foreign same-name script before any fresh deployment mutation', async () => {
    const mutate = vi.fn();

    await expect(
      prepareWorkerScriptOwnership({
        lock: lockWithWorker(),
        targets: TARGET,
        dependencies: {
          list: async () => [{ name: 'test-ar-auth', tag: TAG_B }],
        },
      }).then(() => mutate())
    ).rejects.toThrow('worker_script_fresh_name_conflict:test-ar-auth');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('blocks a delete/recreate tag change before an update mutation', async () => {
    const mutate = vi.fn();
    const prepared = await prepareWorkerScriptOwnership({
      lock: lockWithWorker({ cloudflareScriptTag: TAG_A }),
      targets: TARGET,
      dependencies: {
        list: async () => [{ name: 'test-ar-auth', tag: TAG_A }],
      },
    });
    const list = vi.fn().mockResolvedValueOnce([{ name: 'test-ar-auth', tag: TAG_B }]);
    const raced = await prepareWorkerScriptOwnership({
      lock: prepared.lock,
      targets: TARGET,
      dependencies: { list },
    }).catch((error: unknown) => error);

    expect(raced).toBeInstanceOf(Error);
    expect((raced as Error).message).toContain('worker_script_immutable_tag_mismatch');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rechecks the immutable tag immediately before mutation', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'test-ar-auth', tag: TAG_A }])
      .mockResolvedValueOnce([{ name: 'test-ar-auth', tag: TAG_B }]);
    const prepared = await prepareWorkerScriptOwnership({
      lock: lockWithWorker({ cloudflareScriptTag: TAG_A }),
      targets: TARGET,
      dependencies: { list },
    });
    const mutate = vi.fn();

    await expect(
      prepared.guard.assertBeforeMutation('test-ar-auth').then(() => mutate())
    ).rejects.toThrow('worker_script_immutable_tag_mismatch');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('safely backfills a legacy tag only when the pinned active version still matches', async () => {
    const prepared = await prepareWorkerScriptOwnership({
      lock: lockWithWorker({}),
      targets: TARGET,
      dependencies: {
        list: async () => [{ name: 'test-ar-auth', tag: TAG_A }],
        getDeployment: async () => ({ exists: true, versionId: VERSION_A }),
      },
    });

    expect(prepared.changed).toBe(true);
    expect(prepared.lock.workers?.['ar-auth']?.cloudflareScriptTag).toBe(TAG_A);
    expect(prepared.guard.getEvidence('test-ar-auth')).toEqual({
      workerName: 'test-ar-auth',
      state: 'owned',
      tag: TAG_A,
    });
  });

  it('fails closed when legacy active-version evidence does not match', async () => {
    await expect(
      prepareWorkerScriptOwnership({
        lock: lockWithWorker({}),
        targets: TARGET,
        dependencies: {
          list: async () => [{ name: 'test-ar-auth', tag: TAG_A }],
          getDeployment: async () => ({
            exists: true,
            versionId: '00000000-0000-4000-8000-000000000099',
          }),
        },
      })
    ).rejects.toThrow('worker_script_legacy_version_mismatch');
  });

  it('polls boundedly for a fresh script tag after a committed provider mutation', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'test-ar-auth' }])
      .mockResolvedValueOnce([{ name: 'test-ar-auth', tag: TAG_A }]);
    const sleep = vi.fn(async () => undefined);
    const prepared = await prepareWorkerScriptOwnership({
      lock: lockWithWorker(),
      targets: TARGET,
      dependencies: { list, sleep, captureMaxAttempts: 3 },
      persistProvisional: vi.fn(async () => undefined),
    });

    await expect(prepared.guard.captureAfterMutation('test-ar-auth')).resolves.toBe(TAG_A);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(prepared.guard.getEvidence('test-ar-auth')).toEqual({
      workerName: 'test-ar-auth',
      state: 'owned',
      tag: TAG_A,
    });
  });

  it('resumes a fresh committed deployment after tag readback was temporarily unavailable', async () => {
    const persistCommittedVersion = vi.fn(async () => undefined);
    const initialList = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const initial = await prepareWorkerScriptOwnership({
      lock: lockWithWorker(),
      targets: TARGET,
      dependencies: {
        list: initialList,
        sleep: async () => undefined,
        captureMaxAttempts: 3,
      },
      persistCommittedVersion,
      persistProvisional: vi.fn(async () => undefined),
    });

    await initial.guard.checkpointCommittedVersion('test-ar-auth', VERSION_A);
    await expect(initial.guard.captureAfterMutation('test-ar-auth')).rejects.toThrow(
      'worker_script_identity_readback_timeout'
    );
    expect(persistCommittedVersion).toHaveBeenCalledWith({
      component: 'ar-auth',
      workerName: 'test-ar-auth',
      cloudflareVersionId: VERSION_A,
    });

    const resumed = await prepareWorkerScriptOwnership({
      lock: {
        ...lockWithWorker(),
        workerScriptOwnership: {
          'ar-auth': {
            name: 'test-ar-auth',
            pendingCloudflareVersionId: VERSION_A,
            state: 'pending_tag',
            updatedAt: '2026-08-31T00:00:01.000Z',
          },
        },
      },
      targets: TARGET,
      dependencies: {
        list: async () => [{ name: 'test-ar-auth', tag: TAG_A }],
        getDeployment: async () => ({ exists: true, versionId: VERSION_A }),
      },
    });

    expect(resumed.changed).toBe(true);
    expect(resumed.lock.workerScriptOwnership?.['ar-auth']).toMatchObject({
      name: 'test-ar-auth',
      cloudflareScriptTag: TAG_A,
      state: 'provisional',
    });
    expect(resumed.guard.getEvidence('test-ar-auth')).toEqual({
      workerName: 'test-ar-auth',
      state: 'owned',
      tag: TAG_A,
    });
  });

  it('rejects a non-UUID committed version without journaling it', async () => {
    const persistCommittedVersion = vi.fn(async () => undefined);
    const prepared = await prepareWorkerScriptOwnership({
      lock: lockWithWorker(),
      targets: TARGET,
      dependencies: { list: async () => [] },
      persistCommittedVersion,
      persistProvisional: vi.fn(async () => undefined),
    });

    await expect(
      prepared.guard.checkpointCommittedVersion('test-ar-auth', 'not-a-version-uuid')
    ).rejects.toThrow('invalid_cloudflare_worker_version_id');
    expect(persistCommittedVersion).not.toHaveBeenCalled();
  });

  it('fails closed when a pending fresh version is not the live active version', async () => {
    await expect(
      prepareWorkerScriptOwnership({
        lock: {
          ...lockWithWorker(),
          workerScriptOwnership: {
            'ar-auth': {
              name: 'test-ar-auth',
              pendingCloudflareVersionId: VERSION_A,
              state: 'pending_tag',
              updatedAt: '2026-08-31T00:00:01.000Z',
            },
          },
        },
        targets: TARGET,
        dependencies: {
          list: async () => [{ name: 'test-ar-auth', tag: TAG_B }],
          getDeployment: async () => ({
            exists: true,
            versionId: '00000000-0000-4000-8000-000000000099',
          }),
        },
      })
    ).rejects.toThrow('worker_script_pending_version_mismatch');
  });

  it('keeps a sibling pending checkpoint in the caller lock after a partial multi-Worker commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'authrim-worker-ownership-'));
    const lockPath = join(directory, 'lock.json');
    const lock = lockWithWorker();
    await saveLockFile(lock, lockPath);
    try {
      const prepared = await prepareManagedWorkerScriptOwnership({
        lock,
        lockPath,
        targets: [
          { component: 'ar-auth', workerName: 'test-ar-auth' },
          { component: 'ar-token', workerName: 'test-ar-token' },
        ],
        dependencies: { list: async () => [] },
      });

      await prepared.guard.checkpointCommittedVersion('test-ar-token', VERSION_B);
      const callerMergedLock: AuthrimLock = {
        ...prepared.lock,
        workers: {
          ...prepared.lock.workers,
          'ar-auth': {
            name: 'test-ar-auth',
            deployedAt: '2026-08-31T00:00:02.000Z',
            cloudflareVersionId: VERSION_A,
            cloudflareScriptTag: TAG_A,
          },
        },
      };

      expect(callerMergedLock.workerScriptOwnership?.['ar-token']).toMatchObject({
        name: 'test-ar-token',
        pendingCloudflareVersionId: VERSION_B,
        state: 'pending_tag',
      });
      const durable = JSON.parse(await readFile(lockPath, 'utf-8')) as AuthrimLock;
      expect(durable.workerScriptOwnership?.['ar-token']).toMatchObject({
        pendingCloudflareVersionId: VERSION_B,
        state: 'pending_tag',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never treats a different post-mutation tag as propagation lag', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'test-ar-auth', tag: TAG_A }])
      .mockResolvedValueOnce([{ name: 'test-ar-auth', tag: TAG_B }]);
    const sleep = vi.fn(async () => undefined);
    const prepared = await prepareWorkerScriptOwnership({
      lock: lockWithWorker({ cloudflareScriptTag: TAG_A }),
      targets: TARGET,
      dependencies: { list, sleep, captureMaxAttempts: 3 },
    });

    await expect(prepared.guard.captureAfterMutation('test-ar-auth')).rejects.toThrow(
      'worker_script_immutable_tag_mismatch'
    );
    expect(sleep).not.toHaveBeenCalled();
  });
});
