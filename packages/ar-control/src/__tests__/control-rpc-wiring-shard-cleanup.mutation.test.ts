import { describe, expect, it, vi } from 'vitest';
import { constructionsOf, fn, invoke, make, must } from './support/control-rpc-harness';
import { RESULT } from './support/rpc-wiring-table';
import { defineWiringSuite, useWiringEnvironment } from './support/rpc-wiring-suite';
import { APPROVAL, CLEANUP_ROWS, SHARD_INSTANCE } from './support/cleanup-wiring-rows';

const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
vi.mock('../shard-cleanup', async (orig) =>
  (await recorder()).partial(await orig(), { ShardCleanupService: ['fromEnv'] })
);
vi.mock('../shard-cleanup-repository', async (orig) =>
  (await recorder()).partial(await orig(), { D1ShardCleanupRepository: [] })
);
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await recorder();
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});

useWiringEnvironment();
defineWiringSuite('Control shard cleanup RPC', CLEANUP_ROWS);

describe('shard cleanup service construction', () => {
  it.each(CLEANUP_ROWS.map((row) => [row.rpc, row] as const))(
    '%s builds the service from env, repository, API clients and the clock',
    async (_name, row) => {
      row.setup?.();
      fn(row.call).mockResolvedValue(RESULT);
      const { control, env } = make();
      await invoke(control, row.rpc, row.input);
      const [call] = fn('ShardCleanupService.fromEnv').mock.calls;
      const [passedEnv, , d1, workers, now] = must(call);
      expect(passedEnv).toBe(env);
      expect(must(constructionsOf('D1ShardCleanupRepository')[0]).args).toEqual([env.CONTROL_DB]);
      expect(d1).toEqual({ marker: 'd1' });
      expect(workers).toEqual({ marker: 'workers' });
      expect((now as () => number)()).toBe(1_700_000_000);
    }
  );
});

describe('shard cleanup input validation', () => {
  const stamp = { requestedById: 'operator-1', idempotencyKey: 'idem-1' };
  const reject = async (rpc: string, input: unknown, code: string) => {
    fn('ShardCleanupService.fromEnv').mockReturnValue(SHARD_INSTANCE);
    await expect(invoke(make().control, rpc, input)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
    for (const method of [
      'quarantine',
      'retryQuarantine',
      'approveCleanup',
      'retryCleanup',
      'get',
    ]) {
      expect(fn(`ShardCleanupService.${method}`)).not.toHaveBeenCalled();
    }
  };

  it('rejects malformed quarantine requests', async () => {
    const ok = { shardId: 'shard-1', ...stamp, reasonCode: 'operator_quarantine' };
    const code = 'invalid_shard_quarantine_request';
    await reject('quarantineShard', { ...ok, reasonCode: 'x' }, code);
    await reject('quarantineShard', { ...ok, extra: 1 }, code);
    await reject('quarantineShard', { shardId: 'shard-1' }, code);
    await reject('quarantineShard', null, code);
    await reject('quarantineShard', [ok], code);
    await reject('quarantineShard', { ...ok, shardId: '-x' }, 'invalid_operation_id');
    await reject('quarantineShard', { ...ok, idempotencyKey: '-x' }, 'invalid_operation_id');
    await reject('quarantineShard', { ...ok, requestedById: '' }, code);
    await reject('quarantineShard', { ...ok, requestedById: 'x'.repeat(201) }, code);
    await reject('quarantineShard', { ...ok, requestedById: 'a\u001fb' }, code);
    await reject('quarantineShard', { ...ok, requestedById: 5 }, code);
    await reject('getShardCleanupCandidate', 'bad id', 'invalid_operation_id');
    await reject('getShardCleanupCandidate', 5, 'invalid_operation_id');
  });

  it('rejects malformed retry requests', async () => {
    const quarantine = {
      quarantineOperationId: 'q1',
      ...stamp,
      reasonCode: 'operator_retry_quarantine',
    };
    await reject(
      'retryShardQuarantine',
      { ...quarantine, reasonCode: 'x' },
      'invalid_shard_quarantine_retry_request'
    );
    await reject(
      'retryShardQuarantine',
      { ...quarantine, extra: 1 },
      'invalid_shard_quarantine_retry_request'
    );
    await reject(
      'retryShardQuarantine',
      { ...quarantine, quarantineOperationId: '' },
      'invalid_operation_id'
    );
    await reject(
      'retryShardQuarantine',
      { ...quarantine, idempotencyKey: '' },
      'invalid_operation_id'
    );
    await reject(
      'retryShardQuarantine',
      { ...quarantine, requestedById: '' },
      'invalid_shard_quarantine_retry_request'
    );
    const cleanup = { cleanupOperationId: 'c1', ...stamp, reasonCode: 'operator_retry_cleanup' };
    await reject(
      'retryShardCleanup',
      { ...cleanup, reasonCode: 'x' },
      'invalid_shard_cleanup_retry_request'
    );
    await reject(
      'retryShardCleanup',
      { ...cleanup, extra: 1 },
      'invalid_shard_cleanup_retry_request'
    );
    await reject(
      'retryShardCleanup',
      { ...cleanup, cleanupOperationId: '' },
      'invalid_operation_id'
    );
    await reject('retryShardCleanup', { ...cleanup, idempotencyKey: '' }, 'invalid_operation_id');
    await reject(
      'retryShardCleanup',
      { ...cleanup, requestedById: '' },
      'invalid_shard_cleanup_retry_request'
    );
  });

  it('rejects approvals missing any explicit consent field', async () => {
    const code = 'invalid_shard_cleanup_approval_request';
    await reject('approveShardCleanup', { ...APPROVAL, reasonCode: 'x' }, code);
    await reject('approveShardCleanup', { ...APPROVAL, confirmation: 'DELETE' }, code);
    await reject('approveShardCleanup', { ...APPROVAL, exportMode: 'none' }, code);
    await reject('approveShardCleanup', { ...APPROVAL, exportEvidenceId: 5 }, code);
    await reject('approveShardCleanup', { ...APPROVAL, exportEvidenceId: '-x' }, code);
    await reject('approveShardCleanup', { ...APPROVAL, exportEvidenceId: 'a'.repeat(257) }, code);
    await reject('approveShardCleanup', { ...APPROVAL, deleteDatabase: false }, code);
    await reject('approveShardCleanup', { ...APPROVAL, deleteDatabase: 'true' }, code);
    await reject('approveShardCleanup', { ...APPROVAL, extra: 1 }, code);
    await reject('approveShardCleanup', { ...APPROVAL, requestedById: '' }, code);
    await reject(
      'approveShardCleanup',
      { ...APPROVAL, quarantineOperationId: '' },
      'invalid_operation_id'
    );
    await reject(
      'approveShardCleanup',
      { ...APPROVAL, idempotencyKey: '' },
      'invalid_operation_id'
    );
  });

  it('accepts a skipped export with no evidence and an evidence id of 256 characters', async () => {
    fn('ShardCleanupService.fromEnv').mockReturnValue(SHARD_INSTANCE);
    fn('ShardCleanupService.approveCleanup').mockResolvedValue(RESULT);
    const skipped = { ...APPROVAL, exportMode: 'skipped', exportEvidenceId: null };
    await invoke(make().control, 'approveShardCleanup', skipped);
    expect(fn('ShardCleanupService.approveCleanup')).toHaveBeenLastCalledWith('env-1', skipped);
    const longEvidence = { ...APPROVAL, exportEvidenceId: `a${'b'.repeat(255)}` };
    await invoke(make().control, 'approveShardCleanup', longEvidence);
    expect(fn('ShardCleanupService.approveCleanup')).toHaveBeenLastCalledWith(
      'env-1',
      longEvidence
    );
  });
});
