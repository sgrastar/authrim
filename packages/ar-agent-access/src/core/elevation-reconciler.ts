import type { AdminAgentAuditWrite } from './audit';
import type {
  AgentManagementIdempotencyLookup,
  AgentManagementIdempotencyStatus,
} from './elevation';
import type { StaleAgentElevation } from './repositories';

export interface AgentElevationRecoveryRepository {
  listStaleElevationExecutions(now: number, limit?: number): Promise<StaleAgentElevation[]>;
  reconcileStaleElevation(input: {
    tenantId: string;
    challengeId: string;
    expectedAttempt: number;
    expectedFence: number;
    staleBefore: number;
    status: 'consumed' | 'failed' | 'indeterminate';
    resultEnvelope?: string;
    resultDigest?: string;
    reconciledAt: number;
    audit: AdminAgentAuditWrite;
  }): Promise<boolean>;
  deferStaleElevation(input: {
    tenantId: string;
    challengeId: string;
    expectedAttempt: number;
    expectedFence: number;
    staleBefore: number;
    leaseExpiresAt: number;
  }): Promise<boolean>;
}

export interface AgentManagementIdempotencyStatusPort {
  lookup(input: AgentManagementIdempotencyLookup): Promise<AgentManagementIdempotencyStatus>;
}

export interface AgentElevationReconcilerOptions {
  repository: AgentElevationRecoveryRepository;
  idempotencyStatus: AgentManagementIdempotencyStatusPort;
  reconcilerId: string;
  createAuditId(): string;
  now(): number;
  /** Prevents a target-side in-progress lease from suppressing recovery indefinitely. */
  maximumDeferMilliseconds?: number;
}

export interface AgentElevationReconcileSummary {
  inspected: number;
  consumed: number;
  failed: number;
  indeterminate: number;
  deferred: number;
  lostRace: number;
}

function emptySummary(): AgentElevationReconcileSummary {
  return {
    inspected: 0,
    consumed: 0,
    failed: 0,
    indeterminate: 0,
    deferred: 0,
    lostRace: 0,
  };
}

function createRecoveryAudit(
  stale: StaleAgentElevation,
  status: 'consumed' | 'failed' | 'indeterminate',
  idempotencyStatus: AgentManagementIdempotencyStatus,
  options: AgentElevationReconcilerOptions,
  now: number
): AdminAgentAuditWrite {
  return {
    id: options.createAuditId(),
    tenantId: stale.tenantId,
    action:
      status === 'indeterminate' ? 'agent.elevation.indeterminate' : 'agent.elevation.recovered',
    resourceType: 'agent_elevation_challenge',
    resourceId: stale.id,
    severity: status === 'indeterminate' ? 'warn' : 'info',
    actorType: 'system',
    actorSub: `system:${options.reconcilerId}`,
    grantId: stale.grantId,
    elevationId: stale.id,
    metadata: {
      idempotency_status: idempotencyStatus.status,
      execution_attempt: stale.attempt,
      execution_fence: stale.fence,
      execution_lease_expires_at: stale.leaseExpiresAt,
      reconciler_id: options.reconcilerId,
    },
    createdAt: now,
  };
}

/**
 * Platform-neutral stale execution recovery.
 *
 * A missing target record is deliberately never interpreted as "not executed".
 * Automatic retry is a separate, explicitly reviewed path and is not performed here.
 */
export async function reconcileStaleAgentElevations(
  options: AgentElevationReconcilerOptions,
  limit: number = 100
): Promise<AgentElevationReconcileSummary> {
  const now = options.now();
  const maximumDeferMilliseconds = Math.max(1, options.maximumDeferMilliseconds ?? 60_000);
  const staleRows = await options.repository.listStaleElevationExecutions(now, limit);
  const summary = emptySummary();

  for (const stale of staleRows) {
    summary.inspected += 1;
    const lookup = await options.idempotencyStatus.lookup({
      tenantId: stale.tenantId,
      idempotencyKey: stale.id,
      executionAttempt: stale.attempt,
      executionFence: stale.fence,
    });

    if (lookup.status === 'in_progress' && lookup.leaseExpiresAt > now) {
      const leaseExpiresAt = Math.min(lookup.leaseExpiresAt, now + maximumDeferMilliseconds);
      const deferred = await options.repository.deferStaleElevation({
        tenantId: stale.tenantId,
        challengeId: stale.id,
        expectedAttempt: stale.attempt,
        expectedFence: stale.fence,
        staleBefore: now,
        leaseExpiresAt,
      });
      deferred ? (summary.deferred += 1) : (summary.lostRace += 1);
      continue;
    }

    const status =
      lookup.status === 'succeeded'
        ? 'consumed'
        : lookup.status === 'failed'
          ? 'failed'
          : 'indeterminate';
    const audit = createRecoveryAudit(stale, status, lookup, options, now);
    const reconciled = await options.repository.reconcileStaleElevation({
      tenantId: stale.tenantId,
      challengeId: stale.id,
      expectedAttempt: stale.attempt,
      expectedFence: stale.fence,
      staleBefore: now,
      status,
      ...(lookup.status === 'succeeded' || lookup.status === 'failed'
        ? {
            resultEnvelope: lookup.resultEnvelope,
            resultDigest: lookup.resultDigest,
          }
        : {}),
      reconciledAt: now,
      audit,
    });
    if (!reconciled) {
      summary.lostRace += 1;
    } else if (status === 'consumed') {
      summary.consumed += 1;
    } else if (status === 'failed') {
      summary.failed += 1;
    } else {
      summary.indeterminate += 1;
    }
  }

  return summary;
}
