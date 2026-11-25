import { fn } from './control-rpc-harness';
import type { WiringRow } from './rpc-wiring-table';

/** Stubs `ShardCleanupService.fromEnv` to hand back an instance whose methods are recorded. */
export const SHARD_INSTANCE = new Proxy(
  {},
  { get: (_target, property) => fn(`ShardCleanupService.${String(property)}`) }
);
const setup = (): void => {
  fn('ShardCleanupService.fromEnv').mockReturnValue(SHARD_INSTANCE);
};
const common = { setup, dbClasses: ['D1ShardCleanupRepository'] } as const;

const STAMP = { requestedById: 'operator-1', idempotencyKey: 'idem-1' };
const APPROVAL = {
  quarantineOperationId: 'quarantine-1',
  ...STAMP,
  reasonCode: 'operator_approve_cleanup',
  confirmation: 'DELETE_RETIRED_TENANT_SHARD',
  exportMode: 'manual_verified',
  exportEvidenceId: 'evidence-1',
  deleteDatabase: true,
};
export { APPROVAL };

export const CLEANUP_ROWS: readonly WiringRow[] = [
  {
    rpc: 'listShardCleanupCandidates',
    call: 'ShardCleanupService.list',
    args: ['env-1'],
    ...common,
  },
  {
    rpc: 'getShardCleanupCandidate',
    input: 'shard-1',
    call: 'ShardCleanupService.get',
    args: ['env-1', 'shard-1'],
    ...common,
  },
  {
    rpc: 'quarantineShard',
    input: { shardId: 'shard-1', ...STAMP, reasonCode: 'operator_quarantine' },
    call: 'ShardCleanupService.quarantine',
    args: ['env-1', { shardId: 'shard-1', ...STAMP, reasonCode: 'operator_quarantine' }],
    ...common,
  },
  {
    rpc: 'retryShardQuarantine',
    input: {
      quarantineOperationId: 'quarantine-1',
      ...STAMP,
      reasonCode: 'operator_retry_quarantine',
    },
    call: 'ShardCleanupService.retryQuarantine',
    args: [
      'env-1',
      { quarantineOperationId: 'quarantine-1', ...STAMP, reasonCode: 'operator_retry_quarantine' },
    ],
    ...common,
  },
  {
    rpc: 'approveShardCleanup',
    input: APPROVAL,
    call: 'ShardCleanupService.approveCleanup',
    args: ['env-1', APPROVAL],
    ...common,
  },
  {
    rpc: 'retryShardCleanup',
    input: { cleanupOperationId: 'cleanup-1', ...STAMP, reasonCode: 'operator_retry_cleanup' },
    call: 'ShardCleanupService.retryCleanup',
    args: [
      'env-1',
      { cleanupOperationId: 'cleanup-1', ...STAMP, reasonCode: 'operator_retry_cleanup' },
    ],
    ...common,
  },
];
