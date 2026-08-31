import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireEnvironmentOperationLock,
  acquireDeployConfigLock,
  createLockFile,
  getDeployConfigLockPath,
  getNewLockFilePath,
  hasPostProvisioningLockState,
  loadLockFileAuto,
  mergeProvisionedResourcesIntoLock,
  reconcileD1ResourcesInLock,
  reconcileQueueResourcesInLock,
  reconcileSharedKVResourcesInLock,
  withEnvironmentOperationForEnvironment,
  withDeployConfigLock,
  type AuthrimLock,
} from '../core/lock.js';
import { KV_NAMESPACES, getKVNamespaceName } from '../core/naming.js';

function createTestLock(): AuthrimLock {
  const lock = createLockFile('test', {
    d1: [
      { binding: 'DB', name: 'test-authrim-core-db', id: 'stale-core-id' },
      { binding: 'DB_PII', name: 'test-authrim-pii-db', id: 'stale-pii-id' },
      { binding: 'DB_ADMIN', name: 'test-authrim-admin-db', id: 'stale-admin-id' },
      { binding: 'CONTROL_DB', name: 'test-authrim-control-db', id: 'control-id' },
      { binding: 'LOOKUP_DB', name: 'test-authrim-lookup-db', id: 'lookup-id' },
      {
        binding: 'PLUGIN_RUNNER_DB',
        name: 'test-authrim-plugin-runner-db',
        id: 'plugin-runner-id',
      },
    ],
    kv: KV_NAMESPACES.map((binding) => ({
      binding,
      name: getKVNamespaceName('test', binding),
      id: `live-${binding.toLowerCase()}`,
    })),
    queues: [],
    r2: [],
  });
  lock.d1.TEST_TDB_SLOT_0001_CORE = {
    name: 'authrim-test-tdb-slot-0001-core',
    id: 'stale-tenant-core-id',
  };
  return lock;
}

describe('loadLockFileAuto environment identity', () => {
  it('rejects a valid lock copied under a different environment directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-lock-environment-identity-'));
    const path = getNewLockFilePath(directory, 'prod');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(createTestLock(), null, 2)}\n`, { mode: 0o600 });

    try {
      await expect(loadLockFileAuto(directory, 'prod')).rejects.toThrow(
        'Lock environment identity mismatch: expected prod, found test'
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

type OperationLockKind = 'environment' | 'deploy_config';

function operationLockPath(directory: string, kind: OperationLockKind): string {
  return kind === 'environment'
    ? `${join(directory, 'lock.json')}.operation-lock`
    : getDeployConfigLockPath(directory);
}

function acquireTestOperationLock(directory: string, kind: OperationLockKind, operation: string) {
  return kind === 'environment'
    ? acquireEnvironmentOperationLock(join(directory, 'lock.json'), operation)
    : acquireDeployConfigLock({ baseDir: directory, env: 'test', operation });
}

function writeOperationOwner(
  path: string,
  input: { token: string; pid: number; operation: string; env?: string }
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      ...input,
      startedAt: '2026-08-31T00:00:00.000Z',
    }),
    { mode: 0o600 }
  );
}

describe.each(['environment', 'deploy_config'] as const)(
  '%s operation lock stale recovery safety',
  (kind) => {
    it('elects one simultaneous stale reclaimer and never removes its new owner', async () => {
      const directory = mkdtempSync(join(tmpdir(), `authrim-${kind}-stale-race-`));
      const path = operationLockPath(directory, kind);
      writeOperationOwner(path, {
        token: 'stale-owner',
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'stale-operation',
      });
      try {
        const results = await Promise.allSettled([
          acquireTestOperationLock(directory, kind, 'contender-a'),
          acquireTestOperationLock(directory, kind, 'contender-b'),
        ]);
        const acquired = results.filter(
          (
            result
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof acquireTestOperationLock>>
          > => result.status === 'fulfilled'
        );
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        expect(acquired).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(String(rejected[0]!.reason)).toContain('operation_in_progress');
        const current = JSON.parse(readFileSync(path, 'utf-8')) as { operation: string };
        expect(['contender-a', 'contender-b']).toContain(current.operation);
        expect(current.operation).not.toBe('stale-operation');
        expect(existsSync(`${path}.recovery`)).toBe(false);
        await acquired[0]!.value.release();
        expect(existsSync(path)).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('does not let an orphaned recovery gate remove a later live owner', async () => {
      const directory = mkdtempSync(join(tmpdir(), `authrim-${kind}-new-owner-`));
      const path = operationLockPath(directory, kind);
      writeOperationOwner(path, {
        token: 'new-live-owner',
        pid: process.pid,
        operation: 'live-operation',
        env: 'test',
      });
      const liveIdentity = statSync(path);
      writeOperationOwner(`${path}.recovery`, {
        token: 'dead-reclaimer',
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'dead-recovery',
      });
      try {
        await expect(acquireTestOperationLock(directory, kind, 'late-contender')).rejects.toThrow(
          'operation_in_progress:live-operation'
        );
        const after = statSync(path);
        expect({ dev: after.dev, ino: after.ino }).toEqual({
          dev: liveIdentity.dev,
          ino: liveIdentity.ino,
        });
        expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
          token: 'new-live-owner',
          operation: 'live-operation',
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('recovers after a stale reclaimer crashes while holding the fixed gate', async () => {
      const directory = mkdtempSync(join(tmpdir(), `authrim-${kind}-reclaimer-crash-`));
      const path = operationLockPath(directory, kind);
      const recoveryToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      writeOperationOwner(path, {
        token: 'stale-owner',
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'stale-operation',
      });
      const crashedCandidate = `${path}.candidate-${recoveryToken}`;
      writeOperationOwner(crashedCandidate, {
        token: recoveryToken,
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'crashed-reclaimer',
      });
      linkSync(crashedCandidate, `${path}.recovery`);
      try {
        const acquired = await acquireTestOperationLock(directory, kind, 'recovered-operation');
        expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
          pid: process.pid,
          operation: 'recovered-operation',
        });
        expect(existsSync(crashedCandidate)).toBe(false);
        expect(existsSync(`${path}.recovery`)).toBe(false);
        await acquired.release();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('elects one next-generation reclaimer after the previous winner crashes', async () => {
      const directory = mkdtempSync(join(tmpdir(), `authrim-${kind}-reclaimer-election-`));
      const path = operationLockPath(directory, kind);
      const recoveryPath = `${path}.recovery`;
      const gateToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const crashedReclaimerToken = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      writeOperationOwner(path, {
        token: 'stale-owner',
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'stale-operation',
      });
      const crashedGateCandidate = `${path}.candidate-${gateToken}`;
      writeOperationOwner(crashedGateCandidate, {
        token: gateToken,
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'crashed-gate-owner',
      });
      linkSync(crashedGateCandidate, recoveryPath);
      const gateIdentity = statSync(recoveryPath);
      const identityClaim = `${recoveryPath}.stale-${gateIdentity.dev}-${gateIdentity.ino}`;
      linkSync(recoveryPath, identityClaim);
      const crashedReclaimerCandidate = `${path}.candidate-${crashedReclaimerToken}`;
      writeOperationOwner(crashedReclaimerCandidate, {
        token: crashedReclaimerToken,
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'crashed-elected-reclaimer',
      });
      linkSync(crashedReclaimerCandidate, `${identityClaim}.reclaimer-0`);

      try {
        const results = await Promise.allSettled([
          acquireTestOperationLock(directory, kind, 'next-generation-a'),
          acquireTestOperationLock(directory, kind, 'next-generation-b'),
        ]);
        const acquired = results.filter(
          (
            result
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof acquireTestOperationLock>>
          > => result.status === 'fulfilled'
        );
        expect(acquired).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
          pid: process.pid,
        });
        expect(statSync(identityClaim).ino).toBe(gateIdentity.ino);
        expect(existsSync(`${identityClaim}.reclaimer-0`)).toBe(true);
        expect(existsSync(recoveryPath)).toBe(false);
        await acquired[0]!.value.release();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('recovers when a reclaimer crashes after linking its new main lock', async () => {
      const directory = mkdtempSync(join(tmpdir(), `authrim-${kind}-reclaimer-claimed-`));
      const path = operationLockPath(directory, kind);
      const recoveryToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const crashedCandidate = `${path}.candidate-${recoveryToken}`;
      writeOperationOwner(crashedCandidate, {
        token: recoveryToken,
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'crashed-after-claim',
      });
      linkSync(crashedCandidate, `${path}.recovery`);
      linkSync(crashedCandidate, path);
      try {
        const acquired = await acquireTestOperationLock(directory, kind, 'recovered-after-claim');
        expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
          pid: process.pid,
          operation: 'recovered-after-claim',
        });
        expect(existsSync(crashedCandidate)).toBe(false);
        expect(existsSync(`${path}.recovery`)).toBe(false);
        await acquired.release();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('releases only the inode originally claimed by that owner', async () => {
      const directory = mkdtempSync(join(tmpdir(), `authrim-${kind}-owner-inode-`));
      const path = operationLockPath(directory, kind);
      try {
        const acquired = await acquireTestOperationLock(directory, kind, 'original-operation');
        const original = statSync(path);
        const owner = JSON.parse(readFileSync(path, 'utf-8')) as {
          token: string;
          pid: number;
        };
        const replacementPath = `${path}.replacement`;
        writeOperationOwner(replacementPath, {
          token: owner.token,
          pid: owner.pid,
          operation: 'replacement-owner',
          env: 'test',
        });
        renameSync(replacementPath, path);
        const replacement = statSync(path);
        expect(replacement.ino).not.toBe(original.ino);

        await acquired.release();
        expect(existsSync(path)).toBe(true);
        expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
          token: owner.token,
          pid: owner.pid,
          operation: 'replacement-owner',
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it.each(['unlink', 'rename'] as const)(
      'does not emit an unhandled heartbeat rejection after lock-path %s',
      async (mutation) => {
        const directory = mkdtempSync(join(tmpdir(), `authrim-${kind}-heartbeat-${mutation}-`));
        const path = operationLockPath(directory, kind);
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        vi.useFakeTimers();
        let acquired: Awaited<ReturnType<typeof acquireTestOperationLock>> | undefined;
        try {
          acquired = await acquireTestOperationLock(directory, kind, 'heartbeat-owner');
          if (mutation === 'rename') {
            renameSync(path, `${path}.renamed`);
          } else {
            rmSync(path);
          }
          await vi.advanceTimersByTimeAsync(30_001);
          await Promise.resolve();
          expect(unhandled).not.toHaveBeenCalled();
          await acquired.release();
        } finally {
          vi.useRealTimers();
          process.off('unhandledRejection', unhandled);
          await acquired?.release();
          rmSync(directory, { recursive: true, force: true });
        }
      }
    );
  }
);

describe('environment operation lock', () => {
  it('allows only one mutating operation and can be reacquired after release', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-operation-lock-'));
    const lockPath = join(directory, 'lock.json');
    try {
      const first = await acquireEnvironmentOperationLock(lockPath, 'first');
      await expect(acquireEnvironmentOperationLock(lockPath, 'second')).rejects.toThrow(
        `environment_operation_in_progress:first:${process.pid}`
      );
      await first.release();
      const second = await acquireEnvironmentOperationLock(lockPath, 'second');
      await second.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers an operation lock whose owning process no longer exists', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-stale-operation-lock-'));
    const lockPath = join(directory, 'lock.json');
    writeFileSync(
      `${lockPath}.operation-lock`,
      JSON.stringify({
        token: 'stale',
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'stale-operation',
        startedAt: '2026-07-21T00:00:00.000Z',
      })
    );
    try {
      const acquired = await acquireEnvironmentOperationLock(lockPath, 'replacement');
      await acquired.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not steal an environment lock with an expired heartbeat from a live owner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-reused-pid-operation-lock-'));
    const lockPath = join(directory, 'lock.json');
    const operationPath = `${lockPath}.operation-lock`;
    writeFileSync(
      operationPath,
      JSON.stringify({
        token: 'stale-reused-pid',
        pid: process.pid,
        operation: 'crashed-owner',
        startedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const expired = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(operationPath, expired, expired);
    try {
      await expect(acquireEnvironmentOperationLock(lockPath, 'replacement')).rejects.toThrow(
        `environment_operation_in_progress:crashed-owner:${process.pid}`
      );
      expect(JSON.parse(readFileSync(operationPath, 'utf-8'))).toMatchObject({
        token: 'stale-reused-pid',
        pid: process.pid,
        operation: 'crashed-owner',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows independent environments to be mutated concurrently', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-independent-operation-lock-'));
    try {
      const first = await acquireEnvironmentOperationLock(
        getNewLockFilePath(directory, 'first'),
        'first-operation'
      );
      const second = await acquireEnvironmentOperationLock(
        getNewLockFilePath(directory, 'second'),
        'second-operation'
      );
      await second.release();
      await first.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('releases the environment operation lock when the operation throws', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-operation-finally-'));
    try {
      await expect(
        withEnvironmentOperationForEnvironment(
          { baseDir: directory, env: 'test', operation: 'failing-operation' },
          async () => {
            throw new Error('expected failure');
          }
        )
      ).rejects.toThrow('expected failure');

      const next = await acquireEnvironmentOperationLock(
        getNewLockFilePath(directory, 'test'),
        'next-operation'
      );
      await next.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('workspace deploy-config operation lock', () => {
  it('issues opaque ownership proof only for the exact workspace and environment', async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), 'authrim-deploy-proof-first-'));
    const secondDirectory = mkdtempSync(join(tmpdir(), 'authrim-deploy-proof-second-'));
    try {
      const first = await acquireDeployConfigLock({
        baseDir: firstDirectory,
        env: 'test',
        operation: 'deploy',
      });
      const second = await acquireDeployConfigLock({
        baseDir: secondDirectory,
        env: 'test',
        operation: 'deploy',
      });

      await expect(
        first.proof.assertOwned({ baseDir: firstDirectory, env: 'test' })
      ).resolves.toBeUndefined();
      await expect(
        first.proof.assertOwned({ baseDir: firstDirectory, env: 'scaleout' })
      ).rejects.toThrow('deploy_config_lock_proof_environment_mismatch');
      await expect(
        first.proof.assertOwned({ baseDir: secondDirectory, env: 'test' })
      ).rejects.toThrow('deploy_config_lock_proof_workspace_mismatch');

      await second.release();
      await first.release();
      await expect(
        first.proof.assertOwned({ baseDir: firstDirectory, env: 'test' })
      ).rejects.toThrow('deploy_config_lock_proof_released');
    } finally {
      rmSync(firstDirectory, { recursive: true, force: true });
      rmSync(secondDirectory, { recursive: true, force: true });
    }
  });

  it('rejects proof after the exact lock inode is replaced', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-deploy-proof-replaced-'));
    try {
      const acquired = await acquireDeployConfigLock({
        baseDir: directory,
        env: 'test',
        operation: 'deploy',
      });
      const replacementPath = `${acquired.path}.replacement`;
      writeOperationOwner(replacementPath, {
        token: 'replacement-owner-token',
        pid: process.pid,
        operation: 'replacement-operation',
        env: 'test',
      });
      renameSync(replacementPath, acquired.path);

      await expect(acquired.proof.assertOwned({ baseDir: directory, env: 'test' })).rejects.toThrow(
        'deploy_config_lock_proof_ownership_lost'
      );
      await acquired.release();
      expect(existsSync(acquired.path)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails fast across environments and can be reacquired after owner release', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-deploy-config-lock-'));
    try {
      const first = await acquireDeployConfigLock({
        baseDir: directory,
        env: 'test',
        operation: 'deploy',
      });
      const owner = JSON.parse(readFileSync(first.path, 'utf-8')) as {
        token?: unknown;
        pid?: unknown;
        operation?: unknown;
        env?: unknown;
      };

      expect(owner).toMatchObject({ pid: process.pid, operation: 'deploy', env: 'test' });
      expect(owner.token).toMatch(/^[0-9a-f-]{36}$/u);
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
      await expect(
        acquireDeployConfigLock({
          baseDir: directory,
          env: 'scaleout',
          operation: 'update',
        })
      ).rejects.toThrow(`deploy_config_operation_in_progress:deploy:${process.pid}:test`);

      await first.release();
      await first.release();
      const second = await acquireDeployConfigLock({
        baseDir: directory,
        env: 'scaleout',
        operation: 'update',
      });
      await second.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers a deploy-config lock whose owning process is gone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-stale-deploy-config-lock-'));
    const lockPath = getDeployConfigLockPath(directory);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        token: 'stale',
        pid: Number.MAX_SAFE_INTEGER,
        operation: 'stale-deploy',
        env: 'old',
        startedAt: '2026-08-30T00:00:00.000Z',
      })
    );
    try {
      const acquired = await acquireDeployConfigLock({
        baseDir: directory,
        env: 'replacement',
        operation: 'deploy',
      });
      expect(JSON.parse(readFileSync(acquired.path, 'utf-8'))).toMatchObject({
        pid: process.pid,
        operation: 'deploy',
        env: 'replacement',
      });
      expect(statSync(acquired.path).mode & 0o777).toBe(0o600);
      await acquired.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not steal a deploy-config lock with an expired heartbeat from a live owner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-reused-pid-deploy-lock-'));
    const lockPath = getDeployConfigLockPath(directory);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        token: 'stale-reused-pid',
        pid: process.pid,
        operation: 'crashed-deploy',
        env: 'old',
        startedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const expired = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(lockPath, expired, expired);
    try {
      await expect(
        acquireDeployConfigLock({
          baseDir: directory,
          env: 'replacement',
          operation: 'deploy',
        })
      ).rejects.toThrow(`deploy_config_operation_in_progress:crashed-deploy:${process.pid}:old`);
      expect(JSON.parse(readFileSync(lockPath, 'utf-8'))).toMatchObject({
        token: 'stale-reused-pid',
        pid: process.pid,
        operation: 'crashed-deploy',
        env: 'old',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows only the matching owner token to release the lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-owned-deploy-config-lock-'));
    try {
      const acquired = await acquireDeployConfigLock({
        baseDir: directory,
        env: 'test',
        operation: 'deploy',
      });
      writeFileSync(
        acquired.path,
        JSON.stringify({
          token: 'replacement-owner-token',
          pid: process.pid,
          operation: 'external-owner',
          env: 'other',
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 }
      );

      await acquired.release();
      expect(existsSync(acquired.path)).toBe(true);
      expect(JSON.parse(readFileSync(acquired.path, 'utf-8'))).toMatchObject({
        token: 'replacement-owner-token',
        operation: 'external-owner',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not release a lock whose owner PID no longer matches', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-owned-pid-deploy-config-lock-'));
    try {
      const acquired = await acquireDeployConfigLock({
        baseDir: directory,
        env: 'test',
        operation: 'deploy',
      });
      const owner = JSON.parse(readFileSync(acquired.path, 'utf-8')) as { token: string };
      writeFileSync(
        acquired.path,
        JSON.stringify({
          token: owner.token,
          pid: Number.MAX_SAFE_INTEGER,
          operation: 'replacement-process',
          env: 'other',
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 }
      );

      await acquired.release();
      expect(existsSync(acquired.path)).toBe(true);
      expect(JSON.parse(readFileSync(acquired.path, 'utf-8'))).toMatchObject({
        token: owner.token,
        pid: Number.MAX_SAFE_INTEGER,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('releases the deploy-config lock when the guarded operation throws', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-deploy-config-finally-'));
    const lockPath = getDeployConfigLockPath(directory);
    try {
      await expect(
        withDeployConfigLock({ baseDir: directory, env: 'test', operation: 'deploy' }, async () => {
          throw new Error('expected deploy failure');
        })
      ).rejects.toThrow('expected deploy failure');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('interrupted provisioning lock repair', () => {
  it('refreshes only resource identities while preserving provisioning metadata', () => {
    const existing = createTestLock();
    existing.createdAt = '2026-08-30T00:00:00.000Z';
    const refreshed = createLockFile('test', {
      d1: [{ binding: 'DB', name: 'test-authrim-core-db', id: 'fresh-core-id' }],
      kv: [],
      queues: [],
      r2: [],
    });

    const repaired = mergeProvisionedResourcesIntoLock(existing, refreshed);

    expect(repaired.createdAt).toBe('2026-08-30T00:00:00.000Z');
    expect(repaired.d1).toEqual({
      DB: { name: 'test-authrim-core-db', id: 'fresh-core-id' },
    });
    expect(repaired.kv).toEqual({});
  });

  it.each([
    ['productVersion', (lock: AuthrimLock) => (lock.productVersion = '0.4.0')],
    [
      'workers',
      (lock: AuthrimLock) =>
        (lock.workers = {
          'ar-router': { name: 'test-ar-router', deployedAt: '2026-08-31T00:00:00.000Z' },
        }),
    ],
    [
      'releaseUpdate',
      (lock: AuthrimLock) =>
        (lock.releaseUpdate = {
          targetVersion: '0.4.0',
          phase: 'planned',
          manifestChecksum: 'a'.repeat(64),
          startedAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
          appliedTargets: [],
          manualTargets: [],
        }),
    ],
  ])('rejects repair after %s records post-provision state', (_label, mutate) => {
    const existing = createTestLock();
    mutate(existing);
    const refreshed = createTestLock();

    expect(hasPostProvisioningLockState(existing)).toBe(true);
    expect(() => mergeProvisionedResourcesIntoLock(existing, refreshed)).toThrow(
      'provisioning_lock_contains_post_provision_state'
    );
  });
});

describe('reconcileD1ResourcesInLock', () => {
  it('reports same-name identity drift without mutating fixed or assignment bindings', () => {
    const lock = createTestLock();
    lock.d1.DB.id = 'live-core-id';
    delete lock.d1.DB_ADMIN;

    const result = reconcileD1ResourcesInLock(lock, 'test', [
      { name: 'test-authrim-core-db', uuid: 'live-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'live-pii-id' },
      { name: 'test-authrim-admin-db', uuid: 'live-admin-id' },
      { name: 'test-authrim-control-db', uuid: 'control-id' },
      { name: 'test-authrim-lookup-db', uuid: 'lookup-id' },
      { name: 'test-authrim-plugin-runner-db', uuid: 'plugin-runner-id' },
      { name: 'authrim-test-tdb-slot-0001-core', uuid: 'live-tenant-core-id' },
    ]);

    expect(result.updatedBindings).toEqual([]);
    expect(result.missingBindings).toEqual([]);
    expect(result.identityMismatches).toEqual([
      {
        binding: 'DB_PII',
        expectedName: 'test-authrim-pii-db',
        lockedName: 'test-authrim-pii-db',
        lockedId: 'stale-pii-id',
        liveId: 'live-pii-id',
      },
      {
        binding: 'DB_ADMIN',
        expectedName: 'test-authrim-admin-db',
        liveId: 'live-admin-id',
      },
      {
        binding: 'TEST_TDB_SLOT_0001_CORE',
        expectedName: 'authrim-test-tdb-slot-0001-core',
        lockedName: 'authrim-test-tdb-slot-0001-core',
        lockedId: 'stale-tenant-core-id',
        liveId: 'live-tenant-core-id',
      },
    ]);
    expect(result.lock).toBe(lock);
    expect(result.lock.d1.DB_ADMIN).toBeUndefined();
    expect(result.lock.d1.DB_PII.id).toBe('stale-pii-id');
    expect(result.lock.d1.TEST_TDB_SLOT_0001_CORE.id).toBe('stale-tenant-core-id');
  });

  it('reports a required shared database that does not exist by canonical name', () => {
    const lock = createTestLock();

    const result = reconcileD1ResourcesInLock(lock, 'test', [
      { name: 'test-authrim-core-db', uuid: 'stale-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'stale-pii-id' },
      { name: 'test-authrim-control-db', uuid: 'control-id' },
      { name: 'test-authrim-lookup-db', uuid: 'lookup-id' },
      { name: 'test-authrim-plugin-runner-db', uuid: 'plugin-runner-id' },
      { name: 'authrim-test-tdb-slot-0001-core', uuid: 'stale-tenant-core-id' },
    ]);

    expect(result.missingBindings).toEqual([
      { binding: 'DB_ADMIN', name: 'test-authrim-admin-db' },
    ]);
    expect(result.identityMismatches).toEqual([]);
    expect(result.lock.d1.DB_ADMIN).toEqual(lock.d1.DB_ADMIN);
  });

  it('returns the original lock when all shared IDs are current', () => {
    const lock = createTestLock();
    const databases = [
      { name: 'test-authrim-core-db', uuid: 'stale-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'stale-pii-id' },
      { name: 'test-authrim-admin-db', uuid: 'stale-admin-id' },
      { name: 'test-authrim-control-db', uuid: 'control-id' },
      { name: 'test-authrim-lookup-db', uuid: 'lookup-id' },
      { name: 'test-authrim-plugin-runner-db', uuid: 'plugin-runner-id' },
      { name: 'authrim-test-tdb-slot-0001-core', uuid: 'stale-tenant-core-id' },
    ];

    const result = reconcileD1ResourcesInLock(lock, 'test', databases);

    expect(result.updatedBindings).toEqual([]);
    expect(result.missingBindings).toEqual([]);
    expect(result.identityMismatches).toEqual([]);
    expect(result.lock).toBe(lock);
  });

  it('reports a generated tenant database that no longer exists', () => {
    const lock = createTestLock();

    const result = reconcileD1ResourcesInLock(lock, 'test', [
      { name: 'test-authrim-core-db', uuid: 'stale-core-id' },
      { name: 'test-authrim-pii-db', uuid: 'stale-pii-id' },
      { name: 'test-authrim-admin-db', uuid: 'stale-admin-id' },
      { name: 'test-authrim-control-db', uuid: 'control-id' },
      { name: 'test-authrim-lookup-db', uuid: 'lookup-id' },
      { name: 'test-authrim-plugin-runner-db', uuid: 'plugin-runner-id' },
    ]);

    expect(result.missingBindings).toEqual([
      { binding: 'TEST_TDB_SLOT_0001_CORE', name: 'authrim-test-tdb-slot-0001-core' },
    ]);
  });
});

function createLiveKVNamespaces() {
  return KV_NAMESPACES.map((binding) => ({
    title: getKVNamespaceName('test', binding),
    id: `live-${binding.toLowerCase()}`,
  }));
}

describe('reconcileSharedKVResourcesInLock', () => {
  it('reports same-name identity drift without mutating canonical KV bindings', () => {
    const lock = createTestLock();
    lock.kv.AUTHRIM_CONFIG.id = 'stale-config-id';
    delete lock.kv.SETTINGS;

    const result = reconcileSharedKVResourcesInLock(lock, 'test', createLiveKVNamespaces());

    expect(result.updatedBindings).toEqual([]);
    expect(result.missingBindings).toEqual([]);
    expect(result.identityMismatches).toEqual([
      {
        binding: 'SETTINGS',
        expectedName: 'TEST-SETTINGS',
        liveId: 'live-settings',
      },
      {
        binding: 'AUTHRIM_CONFIG',
        expectedName: 'TEST-AUTHRIM_CONFIG',
        lockedName: 'TEST-AUTHRIM_CONFIG',
        lockedId: 'stale-config-id',
        liveId: 'live-authrim_config',
      },
    ]);
    expect(result.lock).toBe(lock);
    expect(result.lock.kv.SETTINGS).toBeUndefined();
    expect(result.lock.kv.AUTHRIM_CONFIG.id).toBe('stale-config-id');
  });

  it('reports a required canonical KV namespace that is missing', () => {
    const lock = createTestLock();
    const namespaces = createLiveKVNamespaces().filter(
      (namespace) => namespace.title !== 'TEST-AUTHRIM_CONFIG'
    );

    const result = reconcileSharedKVResourcesInLock(lock, 'test', namespaces);

    expect(result.missingBindings).toEqual([
      { binding: 'AUTHRIM_CONFIG', name: 'TEST-AUTHRIM_CONFIG' },
    ]);
    expect(result.identityMismatches).toEqual([]);
    expect(result.lock.kv.AUTHRIM_CONFIG).toEqual(lock.kv.AUTHRIM_CONFIG);
  });

  it('returns the original lock when all canonical KV IDs are current', () => {
    const lock = createTestLock();

    const result = reconcileSharedKVResourcesInLock(lock, 'test', createLiveKVNamespaces());

    expect(result.updatedBindings).toEqual([]);
    expect(result.missingBindings).toEqual([]);
    expect(result.identityMismatches).toEqual([]);
    expect(result.lock).toBe(lock);
  });
});

describe('reconcileQueueResourcesInLock', () => {
  const requiredQueues = [{ binding: 'AUDIT_QUEUE', name: 'test-audit-queue' }];

  it('accepts only an exact locked name and immutable live Queue ID', () => {
    const lock = createTestLock();
    lock.queues = {
      AUDIT_QUEUE: { name: 'test-audit-queue', id: 'queue-audit-id' },
    };

    const result = reconcileQueueResourcesInLock(
      lock,
      [{ name: 'test-audit-queue', id: 'queue-audit-id' }],
      requiredQueues
    );

    expect(result.lock).toBe(lock);
    expect(result.updatedBindings).toEqual([]);
    expect(result.missingBindings).toEqual([]);
    expect(result.identityMismatches).toEqual([]);
  });

  it('reports a same-name Queue whose immutable ID changed without mutating the lock', () => {
    const lock = createTestLock();
    lock.queues = {
      AUDIT_QUEUE: { name: 'test-audit-queue', id: 'queue-recorded-id' },
    };

    const result = reconcileQueueResourcesInLock(
      lock,
      [{ name: 'test-audit-queue', id: 'queue-replacement-id' }],
      requiredQueues
    );

    expect(result.identityMismatches).toEqual([
      {
        binding: 'AUDIT_QUEUE',
        expectedName: 'test-audit-queue',
        lockedName: 'test-audit-queue',
        lockedId: 'queue-recorded-id',
        liveId: 'queue-replacement-id',
        reason: 'live_identity_mismatch',
      },
    ]);
    expect(result.lock.queues?.AUDIT_QUEUE.id).toBe('queue-recorded-id');
  });

  it('fails closed when a live Queue inventory row omits its immutable ID', () => {
    const lock = createTestLock();
    lock.queues = {
      AUDIT_QUEUE: { name: 'test-audit-queue', id: 'queue-recorded-id' },
    };

    const result = reconcileQueueResourcesInLock(
      lock,
      [{ name: 'test-audit-queue' }],
      requiredQueues
    );

    expect(result.identityMismatches).toEqual([
      {
        binding: 'AUDIT_QUEUE',
        expectedName: 'test-audit-queue',
        lockedName: 'test-audit-queue',
        lockedId: 'queue-recorded-id',
        reason: 'live_identity_unavailable',
      },
    ]);
  });

  it('reports a locked Queue that is absent from the live inventory', () => {
    const lock = createTestLock();
    lock.queues = {
      AUDIT_QUEUE: { name: 'test-audit-queue', id: 'queue-recorded-id' },
    };

    const result = reconcileQueueResourcesInLock(lock, [], requiredQueues);

    expect(result.missingBindings).toEqual([{ binding: 'AUDIT_QUEUE', name: 'test-audit-queue' }]);
    expect(result.identityMismatches).toEqual([]);
  });

  it('does not adopt a required same-name Queue when its lock identity is absent', () => {
    const lock = createTestLock();

    const result = reconcileQueueResourcesInLock(
      lock,
      [{ name: 'test-audit-queue', id: 'queue-unowned-id' }],
      requiredQueues
    );

    expect(result.identityMismatches).toEqual([
      {
        binding: 'AUDIT_QUEUE',
        expectedName: 'test-audit-queue',
        liveId: 'queue-unowned-id',
        reason: 'locked_identity_missing',
      },
    ]);
    expect(result.lock.queues).toBeUndefined();
  });
});
