import {
  AdminAgentAccessRepository,
  reconcileStaleAgentElevations,
  type AgentElevationReconcileSummary,
} from '@authrim/ar-agent-access/core';
import {
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

export const AGENT_ELEVATION_RECOVERY_CRON = '* * * * *';

interface AgentElevationRecoveryLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
}

interface AgentElevationRecoveryOptions {
  now?: () => number;
  createId?: () => string;
  reconcilerId?: string;
  limit?: number;
}

export function isAgentElevationRecoveryCron(cron: string): boolean {
  return cron === AGENT_ELEVATION_RECOVERY_CRON;
}

/**
 * Runs against DB_ADMIN because both the elevation challenge and the target-side
 * execution ledger are control-plane records. The platform-neutral reconciler owns
 * all status decisions; this module only composes Cloudflare's scheduled entry point.
 */
export async function recoverStaleAgentElevations(
  adapter: DatabaseAdapter,
  options: AgentElevationRecoveryOptions = {}
): Promise<AgentElevationReconcileSummary> {
  const repository = new AdminAgentAccessRepository(adapter);
  const summary = await reconcileStaleAgentElevations(
    {
      repository,
      idempotencyStatus: {
        lookup: (input) => repository.lookupManagementExecution(input),
      },
      reconcilerId: options.reconcilerId ?? 'ar-management-scheduled',
      createAuditId: options.createId ?? (() => `audit_agent_${crypto.randomUUID()}`),
      now: options.now ?? (() => Date.now()),
    },
    options.limit ?? 100
  );
  await repository.purgeExpiredElevationPayloads((options.now ?? (() => Date.now()))());
  return summary;
}

export async function processScheduledAgentElevationRecovery(
  env: Env,
  log: AgentElevationRecoveryLogger
): Promise<AgentElevationReconcileSummary | null> {
  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(env, 'agent-elevation-recovery');
    const summary = await recoverStaleAgentElevations(adapter);
    log.info('Agent elevation recovery completed', { ...summary });
    return summary;
  } catch (error) {
    log.error('Agent elevation recovery failed', {}, error as Error);
    return null;
  }
}
