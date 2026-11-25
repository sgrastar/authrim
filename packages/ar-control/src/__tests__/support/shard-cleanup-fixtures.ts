import { vi } from 'vitest';
import { ShardCleanupService } from '../../shard-cleanup';

export const NOW = 1_800_000_000;
export type Mock = ReturnType<typeof vi.fn>;
export type Repo = Record<string, Mock>;

const REPOSITORY_METHODS = [
  'list',
  'get',
  'findExistingOperation',
  'startQuarantine',
  'approveCleanup',
  'retryCleanup',
  'retryQuarantine',
  'listDueQuarantines',
  'listDueCleanups',
  'countActiveReferences',
  'recordQuarantineWaiting',
  'markQuarantineReady',
  'markQuarantineBlocked',
  'recordQuarantineTenantEvidence',
  'markCleanupBlocked',
  'markCleanupWaiting',
  'markCleanupRunning',
  'markCleanupSucceeded',
  'getQuarantineTargetForCleanup',
  'listPendingBindings',
  'markBindingsComplete',
  'markDatabaseDeletionStarted',
  'markDatabaseDeleteRequested',
  'acquireDeploymentLease',
  'releaseDeploymentLease',
  'leaseIsCurrent',
  'markBindingAlreadyAbsent',
  'recordBindingRemovalStarted',
  'markBindingRemoved',
] as const;

export function repository(): Repo {
  return Object.fromEntries(REPOSITORY_METHODS.map((name) => [name, vi.fn()]));
}

export function service(repo: Repo, overrides: Record<string, unknown> = {}) {
  const d1 = { getD1Database: vi.fn(), deleteD1Database: vi.fn() };
  const workers = {
    getWorkerSettings: vi.fn(),
    patchWorkerSettings: vi.fn(),
    listWorkerDeployments: vi.fn(),
  };
  const instance = new ShardCleanupService({
    repository: repo as never,
    d1,
    workers,
    destructiveOperationsEnabled: true,
    now: () => NOW,
    ...overrides,
  });
  return { instance, d1, workers };
}

export const VIEW = { shardId: 'shard-1', cleanupOperationId: 'cleanup-op' };
export const QUARANTINE_REQUEST = {
  shardId: 'shard-1',
  requestedById: 'admin-1',
  reasonCode: 'operator_quarantine',
  idempotencyKey: 'idem-1',
} as const;
export const APPROVAL = {
  quarantineOperationId: 'quarantine-op',
  requestedById: 'admin-1',
  reasonCode: 'operator_approve_cleanup',
  idempotencyKey: 'idem-2',
  confirmation: 'DELETE_RETIRED_TENANT_SHARD',
  exportMode: 'manual_verified',
  exportEvidenceId: 'evidence-1',
  deleteDatabase: true,
} as const;

/** The first argument of a recorded call, as a loosely typed record. */
export function callArg(mock: Mock, call = 0): Record<string, unknown> {
  return (mock.mock.calls[call]?.[0] ?? {}) as Record<string, unknown>;
}
