import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlRepository } from '../repository';
import { ControlService } from '../service';
import type { ControlEnv } from '../types';

const effect = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core/control-plane', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core/control-plane')>()),
  executeControlProvisioningEffect: effect,
}));

const NOW = 1_800_000_123;
type Repo = Record<string, ReturnType<typeof vi.fn>>;
const READY_ENV = {
  AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
  CLOUDFLARE_D1_API_TOKEN: 'd1',
  CLOUDFLARE_WORKERS_API_TOKEN: 'workers',
} as ControlEnv;
const LEASE = {
  operation: { operationId: 'op-1', environmentId: 'env-1', status: 'running' },
  ownerId: 'owner',
  fencingToken: 2,
};
const OPERATION = { operationId: 'op-1', status: 'blocked', lastErrorCode: 'x' };
const PLAN = {
  operationId: 'op-1',
  environmentId: 'env-1',
  readReplicationMode: 'enabled',
  dataRole: 'tenant_core/users',
};

beforeEach(() => {
  effect.mockReset();
  effect.mockImplementation((options: unknown) => Promise.resolve(options));
});

function repo(overrides: Repo = {}): Repo {
  return {
    listPendingShardPlans: vi.fn().mockResolvedValue([]),
    listPendingMigrationPlans: vi.fn().mockResolvedValue([]),
    getProvisioningAuthority: vi.fn().mockResolvedValue({
      automaticProvisioningEnabled: true,
      tokenOwnership: 'account',
      capabilityState: 'ready',
    }),
    tryStartProvisioning: vi.fn().mockResolvedValue(LEASE),
    tryStartMigration: vi.fn().mockResolvedValue(LEASE),
    getOperation: vi.fn().mockResolvedValue(OPERATION),
    markDatabaseCreated: vi.fn().mockResolvedValue(OPERATION),
    markOperationRetry: vi.fn().mockResolvedValue(undefined),
    markOperationBlocked: vi.fn().mockResolvedValue(undefined),
    markMigrationReady: vi.fn().mockResolvedValue(OPERATION),
    markMigrationRetry: vi.fn().mockResolvedValue(undefined),
    markMigrationBlocked: vi.fn().mockResolvedValue(undefined),
    readD1CreateCheckpoint: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

async function capture(repository: Repo, kind: 'provision' | 'migration') {
  const service = new ControlService({
    repository: repository as unknown as ControlRepository,
    env: READY_ENV,
    now: () => NOW,
    createApiClient: () => ({}) as never,
    createMigrationEngine: () => ({}) as never,
  });
  if (kind === 'provision') {
    repository.listPendingShardPlans.mockResolvedValue([PLAN]);
  } else {
    repository.listPendingMigrationPlans.mockResolvedValue([PLAN]);
  }
  await service.reconcilePending();
  const options = effect.mock.calls[0]?.[0] as {
    executor: string;
    effect: string;
    operation: unknown;
    now: () => number;
    execute: () => Promise<unknown>;
    onSuccess: (value: unknown) => Promise<unknown>;
    onRetry: (decision: { code: string; nextAttemptAt: number | null }) => Promise<unknown>;
    onBlocked: (decision: { code: string }) => Promise<unknown>;
  };
  return options;
}

describe('provisioning effect callbacks', () => {
  it('runs the create_d1 effect for the control executor under the lease', async () => {
    const options = await capture(repo(), 'provision');
    expect(options).toMatchObject({
      executor: 'control',
      effect: 'create_d1',
      operation: LEASE.operation,
    });
    expect(options.now()).toBe(NOW);
  });

  it('refuses to create a database when the checkpoint cannot be read under the lease', async () => {
    const options = await capture(repo(), 'provision');
    await expect(options.execute()).rejects.toThrow(/^control_d1_create_checkpoint_unreadable$/u);
  });

  it('records the created database with the planned replication mode', async () => {
    const repository = repo();
    const options = await capture(repository, 'provision');
    await expect(options.onSuccess('database-1')).resolves.toBe(OPERATION);
    expect(repository.markDatabaseCreated).toHaveBeenCalledExactlyOnceWith(
      LEASE,
      PLAN,
      'database-1',
      'enabled',
      NOW
    );
  });

  it('records a retry and re-reads the operation', async () => {
    const repository = repo();
    const options = await capture(repository, 'provision');
    repository.getOperation.mockClear();
    await expect(options.onRetry({ code: 'cf_rate', nextAttemptAt: NOW + 60 })).resolves.toBe(
      OPERATION
    );
    expect(repository.markOperationRetry).toHaveBeenCalledExactlyOnceWith(
      LEASE,
      'cf_rate',
      NOW + 60,
      NOW
    );
    expect(repository.getOperation).toHaveBeenCalledExactlyOnceWith('op-1');
  });

  it('refuses a retry decision without a time', async () => {
    const repository = repo();
    const options = await capture(repository, 'provision');
    await expect(options.onRetry({ code: 'cf_rate', nextAttemptAt: null })).rejects.toThrow(
      /^control_provisioning_retry_time_missing$/u
    );
    expect(repository.markOperationRetry).not.toHaveBeenCalled();
  });

  it('records a block and re-reads the operation', async () => {
    const repository = repo();
    const options = await capture(repository, 'provision');
    repository.getOperation.mockClear();
    await expect(options.onBlocked({ code: 'cf_denied' })).resolves.toBe(OPERATION);
    expect(repository.markOperationBlocked).toHaveBeenCalledExactlyOnceWith(
      LEASE,
      'cf_denied',
      NOW
    );
    expect(repository.getOperation).toHaveBeenCalledExactlyOnceWith('op-1');
  });

  it('reports a vanished operation after a retry or block', async () => {
    const repository = repo();
    const options = await capture(repository, 'provision');
    repository.getOperation.mockResolvedValue(null);
    await expect(options.onRetry({ code: 'c', nextAttemptAt: NOW + 1 })).rejects.toThrow(
      /^control_operation_missing_after_provider_failure$/u
    );
    await expect(options.onBlocked({ code: 'c' })).rejects.toThrow(
      /^control_operation_missing_after_provider_failure$/u
    );
  });
});

describe('migration effect callbacks', () => {
  it('runs the apply_migrations effect for the control executor', async () => {
    const options = await capture(repo(), 'migration');
    expect(options).toMatchObject({
      executor: 'control',
      effect: 'apply_migrations',
      operation: LEASE.operation,
    });
    expect(options.now()).toBe(NOW);
  });

  it('records the finished migrations', async () => {
    const repository = repo();
    const options = await capture(repository, 'migration');
    const result = { totalFiles: 2, lastFilename: '0002.sql' };
    await expect(options.onSuccess(result)).resolves.toBe(OPERATION);
    expect(repository.markMigrationReady).toHaveBeenCalledExactlyOnceWith(LEASE, PLAN, result, NOW);
  });

  it('records a retry or block and re-reads the operation', async () => {
    const repository = repo();
    const options = await capture(repository, 'migration');
    await options.onRetry({ code: 'm_retry', nextAttemptAt: NOW + 5 });
    await options.onBlocked({ code: 'm_blocked' });
    expect(repository.markMigrationRetry).toHaveBeenCalledExactlyOnceWith(
      LEASE,
      'm_retry',
      NOW + 5,
      NOW
    );
    expect(repository.markMigrationBlocked).toHaveBeenCalledExactlyOnceWith(
      LEASE,
      'm_blocked',
      NOW
    );
    await expect(options.onRetry({ code: 'm', nextAttemptAt: null })).rejects.toThrow(
      /^control_provisioning_retry_time_missing$/u
    );
    repository.getOperation.mockResolvedValue(null);
    await expect(options.onRetry({ code: 'm', nextAttemptAt: 1 })).rejects.toThrow(
      /^control_operation_missing_after_migration_failure$/u
    );
    await expect(options.onBlocked({ code: 'm' })).rejects.toThrow(
      /^control_operation_missing_after_migration_failure$/u
    );
  });
});
