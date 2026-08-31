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
          checkpoint: { state: 'not_started', providerResourceId: null },
          reserveCreate: async () => {
            calls.push('reserve');
            return true;
          },
          markCreateIssued: async () => {
            calls.push('issued');
          },
          markCreateDefinitelyRejected: async () => {
            calls.push('rejected');
          },
          checkpointProviderIdentity: async (databaseId) => {
            calls.push(`checkpoint:${databaseId}`);
          },
        })
      ).resolves.toBe('database-id');
      expect(calls).toEqual([
        'reserve',
        'issued',
        'create:authrim-test-shard',
        'checkpoint:database-id',
        'replication:auto',
        'reflect',
      ]);
    }
  );

  it('rejects an unowned existing deterministic D1 without consuming create capacity', async () => {
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
        checkpoint: { state: 'not_started', providerResourceId: null },
        reserveCreate: async () => {
          reserved = true;
          return true;
        },
        markCreateIssued: async () => undefined,
        markCreateDefinitelyRejected: async () => undefined,
        checkpointProviderIdentity: async () => undefined,
      })
    ).rejects.toThrow('cloudflare_d1_name_conflict');
    expect(reserved).toBe(false);
  });

  it('resumes an identified create only by its exact immutable UUID', async () => {
    const calls: string[] = [];
    await expect(
      ensureControlProvisioningD1({
        plan: { databaseName: 'authrim-test-shard', readReplicationMode: 'disabled' },
        provider: {
          listD1Databases: async () => {
            throw new Error('unexpected_list');
          },
          createD1Database: async () => {
            throw new Error('unexpected_create');
          },
          updateD1Database: async () => {
            throw new Error('unexpected_update');
          },
          getD1Database: async (databaseId: string) => {
            calls.push(`get:${databaseId}`);
            return {
              uuid: databaseId,
              name: 'authrim-test-shard',
              read_replication: { mode: 'disabled' },
            };
          },
        },
        checkpoint: { state: 'identified', providerResourceId: 'database-id' },
        reserveCreate: async () => {
          throw new Error('unexpected_reserve');
        },
        markCreateIssued: async () => {
          throw new Error('unexpected_issue');
        },
        markCreateDefinitelyRejected: async () => {
          throw new Error('unexpected_rejection');
        },
        checkpointProviderIdentity: async () => {
          throw new Error('unexpected_checkpoint');
        },
      })
    ).resolves.toBe('database-id');
    expect(calls).toEqual(['get:database-id', 'get:database-id']);
  });

  it('does not reissue a create whose response may have been lost', async () => {
    let creates = 0;
    await expect(
      ensureControlProvisioningD1({
        plan: { databaseName: 'authrim-test-shard', readReplicationMode: 'disabled' },
        provider: {
          listD1Databases: async () => [],
          createD1Database: async () => {
            creates += 1;
            throw new Error('unexpected_create');
          },
          updateD1Database: async () => {
            throw new Error('unexpected_update');
          },
          getD1Database: async () => {
            throw new Error('unexpected_get');
          },
        },
        checkpoint: { state: 'issued', providerResourceId: null },
        reserveCreate: async () => true,
        markCreateIssued: async () => undefined,
        markCreateDefinitelyRejected: async () => undefined,
        checkpointProviderIdentity: async () => undefined,
      })
    ).rejects.toThrow('cloudflare_d1_create_outcome_ambiguous');
    expect(creates).toBe(0);
  });

  it('checkpoints the UUID before any post-create provider operation', async () => {
    const calls: string[] = [];
    await expect(
      ensureControlProvisioningD1({
        plan: { databaseName: 'authrim-test-shard', readReplicationMode: 'disabled' },
        provider: {
          listD1Databases: async () => [],
          createD1Database: async () => {
            calls.push('create');
            return {
              uuid: 'database-id',
              name: 'authrim-test-shard',
              read_replication: { mode: 'disabled' },
            };
          },
          updateD1Database: async () => {
            throw new Error('unexpected_update');
          },
          getD1Database: async () => {
            calls.push('reflect');
            return {
              uuid: 'database-id',
              name: 'authrim-test-shard',
              read_replication: { mode: 'disabled' },
            };
          },
        },
        checkpoint: { state: 'not_started', providerResourceId: null },
        reserveCreate: async () => {
          calls.push('reserve');
          return true;
        },
        markCreateIssued: async () => {
          calls.push('issued');
        },
        markCreateDefinitelyRejected: async () => undefined,
        checkpointProviderIdentity: async () => {
          calls.push('checkpoint');
          throw new Error('simulated_checkpoint_crash');
        },
      })
    ).rejects.toThrow('simulated_checkpoint_crash');
    expect(calls).toEqual(['reserve', 'issued', 'create', 'checkpoint']);
  });

  it('resets the issued checkpoint after a definite provider rejection', async () => {
    const calls: string[] = [];
    await expect(
      ensureControlProvisioningD1({
        plan: { databaseName: 'authrim-test-shard', readReplicationMode: 'disabled' },
        provider: {
          listD1Databases: async () => [],
          createD1Database: async () => {
            throw { status: 429 };
          },
          updateD1Database: async () => {
            throw new Error('unexpected_update');
          },
          getD1Database: async () => {
            throw new Error('unexpected_get');
          },
        },
        checkpoint: { state: 'not_started', providerResourceId: null },
        reserveCreate: async () => true,
        markCreateIssued: async () => {
          calls.push('issued');
        },
        markCreateDefinitelyRejected: async () => {
          calls.push('rejected');
        },
        checkpointProviderIdentity: async () => undefined,
      })
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toEqual(['issued', 'rejected']);
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
        checkpoint: { state: 'not_started', providerResourceId: null },
        reserveCreate: async () => true,
        markCreateIssued: async () => undefined,
        markCreateDefinitelyRejected: async () => undefined,
        checkpointProviderIdentity: async () => undefined,
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
