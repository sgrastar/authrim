import { describe, expect, it } from 'vitest';
import {
  classifyControlProvisioningFailure,
  controlProvisioningRetryDelaySeconds,
  decideControlProvisioningFailure,
  ensureControlProvisioningD1,
  executeControlProvisioningEffect,
} from '../provisioning-engine.js';

const operation = {
  operationId: 'op_deterministic_1',
  attemptCount: 2,
  createdAt: 1_000,
  retryBudgetStartedAt: 1_000,
};

describe('shared Control provisioning failure policy', () => {
  it.each(['control', 'setup'] as const)(
    'uses the same idempotent D1 create and reflection effect for %s',
    async () => {
      const calls: string[] = [];
      const provider = {
        listD1Databases: async () => [],
        createD1Database: async ({ name }: { name: string }) => {
          calls.push(`create:${name}`);
          return { uuid: 'database-id', name, read_replication: { mode: 'disabled' } };
        },
        updateD1Database: async (
          _databaseId: string,
          input: { read_replication: { mode: 'auto' | 'disabled' } }
        ) => {
          calls.push(`replication:${input.read_replication.mode}`);
          return {
            uuid: 'database-id',
            name: 'authrim-test-shard',
            read_replication: { mode: input.read_replication.mode },
          };
        },
        getD1Database: async () => {
          calls.push('reflect');
          return {
            uuid: 'database-id',
            name: 'authrim-test-shard',
            read_replication: { mode: 'auto' },
          };
        },
      };
      await expect(
        ensureControlProvisioningD1({
          plan: {
            databaseName: 'authrim-test-shard',
            readReplicationMode: 'enabled',
          },
          provider,
          reserveCreate: async () => {
            calls.push('reserve');
            return true;
          },
        })
      ).resolves.toBe('database-id');
      expect(calls).toEqual([
        'reserve',
        'create:authrim-test-shard',
        'replication:auto',
        'reflect',
      ]);
    }
  );

  it('adopts an existing deterministic D1 without consuming create capacity', async () => {
    let reserved = false;
    await expect(
      ensureControlProvisioningD1({
        plan: { databaseName: 'authrim-test-shard', readReplicationMode: 'disabled' },
        provider: {
          listD1Databases: async () => [
            {
              uuid: 'database-id',
              name: 'authrim-test-shard',
              read_replication: { mode: 'disabled' },
            },
          ],
          createD1Database: async () => {
            throw new Error('unexpected_create');
          },
          updateD1Database: async () => {
            throw new Error('unexpected_update');
          },
          getD1Database: async () => ({
            uuid: 'database-id',
            name: 'authrim-test-shard',
            read_replication: { mode: 'disabled' },
          }),
        },
        reserveCreate: async () => {
          reserved = true;
          return true;
        },
      })
    ).resolves.toBe('database-id');
    expect(reserved).toBe(false);
  });

  it('fails closed when the reflected replication mode is wrong', async () => {
    await expect(
      ensureControlProvisioningD1({
        plan: { databaseName: 'authrim-test-shard', readReplicationMode: 'disabled' },
        provider: {
          listD1Databases: async () => [],
          createD1Database: async () => ({
            uuid: 'database-id',
            name: 'authrim-test-shard',
            read_replication: { mode: 'disabled' },
          }),
          updateD1Database: async () => {
            throw new Error('unexpected_update');
          },
          getD1Database: async () => ({
            uuid: 'database-id',
            name: 'authrim-test-shard',
            read_replication: { mode: 'auto' },
          }),
        },
        reserveCreate: async () => true,
      })
    ).rejects.toThrow('cloudflare_d1_replication_state_mismatch');
  });

  it('classifies the same credential failure for setup and Control adapters structurally', () => {
    expect(classifyControlProvisioningFailure('create_d1', { status: 403 })).toEqual({
      code: 'cloudflare_d1_capability_rejected',
      permanent: true,
    });
    expect(classifyControlProvisioningFailure('apply_migrations', { status: 403 })).toEqual({
      code: 'cloudflare_d1_capability_rejected',
      permanent: true,
    });
  });

  it('uses deterministic backoff for concurrent executors', () => {
    expect(controlProvisioningRetryDelaySeconds(operation)).toBe(
      controlProvisioningRetryDelaySeconds({ ...operation })
    );
    expect(
      decideControlProvisioningFailure({
        effect: 'create_d1',
        operation,
        error: { status: 429 },
        failedAt: 1_100,
      })
    ).toEqual({
      code: 'cloudflare_d1_request_failed',
      permanent: false,
      disposition: 'retry',
      nextAttemptAt: 1_100 + controlProvisioningRetryDelaySeconds(operation),
    });
  });

  it('blocks checksum and release failures without retrying provider mutation', () => {
    expect(
      decideControlProvisioningFailure({
        effect: 'apply_migrations',
        operation,
        error: new Error('migration_release_manifest_digest_mismatch'),
        failedAt: 1_100,
      })
    ).toMatchObject({
      code: 'migration_release_manifest_digest_mismatch',
      disposition: 'blocked',
      nextAttemptAt: null,
    });
  });

  it('defers a D1 create budget exhaustion until the next UTC budget day', () => {
    expect(
      decideControlProvisioningFailure({
        effect: 'create_d1',
        operation,
        error: new Error('control_daily_d1_budget_exhausted'),
        failedAt: 86_401,
      })
    ).toEqual({
      code: 'control_daily_d1_budget_exhausted',
      permanent: false,
      disposition: 'retry',
      nextAttemptAt: 172_800,
    });
  });

  it('blocks transient errors after the operation retry budget expires', () => {
    expect(
      decideControlProvisioningFailure({
        effect: 'apply_migrations',
        operation,
        error: new Error('migration_d1_batch_failed'),
        failedAt: 8_200,
      })
    ).toMatchObject({
      code: 'control_migration_retry_budget_exhausted',
      disposition: 'blocked',
      nextAttemptAt: null,
    });
  });

  it.each(['control', 'setup'] as const)(
    'runs the same success transition for the %s executor',
    async (executor) => {
      const transitions: string[] = [];
      await expect(
        executeControlProvisioningEffect({
          executor,
          effect: 'create_d1',
          operation,
          execute: async () => 'database-id',
          onSuccess: async (databaseId) => {
            transitions.push(`success:${databaseId}`);
            return 'ready';
          },
          onRetry: async () => 'retry',
          onBlocked: async () => 'blocked',
          now: () => 1_100,
        })
      ).resolves.toBe('ready');
      expect(transitions).toEqual(['success:database-id']);
    }
  );

  it('routes setup and Control failures through the same redacted retry transition', async () => {
    const decisions: ReturnType<typeof decideControlProvisioningFailure>[] = [];
    await expect(
      executeControlProvisioningEffect({
        executor: 'setup',
        effect: 'apply_migrations',
        operation,
        execute: async () => {
          throw Object.assign(new Error('provider body must not escape'), { status: 429 });
        },
        onSuccess: async () => 'ready',
        onRetry: async (decision) => {
          decisions.push(decision);
          return 'retry';
        },
        onBlocked: async () => 'blocked',
        now: () => 1_100,
      })
    ).resolves.toBe('retry');
    expect(decisions).toEqual([
      {
        code: 'cloudflare_d1_migration_failed',
        permanent: false,
        disposition: 'retry',
        nextAttemptAt: 1_100 + controlProvisioningRetryDelaySeconds(operation),
      },
    ]);
  });
});
