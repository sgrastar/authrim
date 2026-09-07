import {
  AdminAgentAccessRepository,
  type ClaimedAgentTokenRevocation,
} from '@authrim/ar-agent-access/core';
import { CloudflareRefreshFamilyRevoker } from '@authrim/ar-agent-access/platform/cloudflare/refresh-family-revoker';
import type { AgentRefreshFamilyRevokerPort } from '@authrim/ar-agent-access/platform/ports';
import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';

interface AgentTokenRevocationRepository {
  listClaimableTokenRevocations(now: number, limit?: number): Promise<string[]>;
  claimTokenRevocationOutbox(input: {
    outboxId: string;
    ownerId: string;
    now: number;
    leaseExpiresAt: number;
  }): Promise<ClaimedAgentTokenRevocation | null>;
  completeTokenRevocationOutbox(input: {
    outboxId: string;
    tenantId: string;
    ownerId: string;
    fence: number;
    completionId: string;
    familyIds: readonly string[];
    completedAt: number;
  }): Promise<boolean>;
  failTokenRevocationOutbox(
    input: Parameters<AdminAgentAccessRepository['failTokenRevocationOutbox']>[0]
  ): ReturnType<AdminAgentAccessRepository['failTokenRevocationOutbox']>;
}

interface AgentTokenRevocationLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
}

interface AgentTokenRevocationOptions {
  now?: () => number;
  createId?: (prefix: string) => string;
  leaseMilliseconds?: number;
  maxAttempts?: number;
  limit?: number;
}

export interface AgentTokenRevocationSummary {
  scanned: number;
  claimed: number;
  completed: number;
  retryScheduled: number;
  deadLetter: number;
  lostRace: number;
}

function retryDelayMilliseconds(attempt: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.max(0, Math.min(attempt - 1, 8)));
}

export async function processAgentTokenRevocationOutbox(
  repository: AgentTokenRevocationRepository,
  revoker: AgentRefreshFamilyRevokerPort,
  options: AgentTokenRevocationOptions = {}
): Promise<AgentTokenRevocationSummary> {
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? ((prefix: string) => `${prefix}_${crypto.randomUUID()}`);
  const startedAt = now();
  const leaseMilliseconds = Math.max(1, options.leaseMilliseconds ?? 60_000);
  const outboxIds = await repository.listClaimableTokenRevocations(startedAt, options.limit ?? 100);
  const summary: AgentTokenRevocationSummary = {
    scanned: outboxIds.length,
    claimed: 0,
    completed: 0,
    retryScheduled: 0,
    deadLetter: 0,
    lostRace: 0,
  };

  for (const outboxId of outboxIds) {
    const ownerId = createId('agent-revoker');
    const claimed = await repository.claimTokenRevocationOutbox({
      outboxId,
      ownerId,
      now: startedAt,
      leaseExpiresAt: startedAt + leaseMilliseconds,
    });
    if (!claimed) {
      summary.lostRace += 1;
      continue;
    }
    summary.claimed += 1;
    try {
      for (let index = 0; index < claimed.familyIds.length; index += 1) {
        await revoker.revoke({
          tenantId: claimed.tenantId,
          clientId: claimed.clientId,
          familyId: claimed.familyIds[index],
          familyJti: claimed.familyJtis[index],
          reason: claimed.reason,
        });
      }
      const completed = await repository.completeTokenRevocationOutbox({
        outboxId: claimed.id,
        tenantId: claimed.tenantId,
        ownerId: claimed.ownerId,
        fence: claimed.fence,
        completionId: createId('agent-revocation-completion'),
        familyIds: claimed.familyIds,
        completedAt: now(),
      });
      completed ? (summary.completed += 1) : (summary.lostRace += 1);
    } catch {
      const failedAt = now();
      const outcome = await repository.failTokenRevocationOutbox({
        outboxId: claimed.id,
        tenantId: claimed.tenantId,
        ownerId: claimed.ownerId,
        fence: claimed.fence,
        expectedAttempt: claimed.attempt,
        nextAttemptAt: failedAt + retryDelayMilliseconds(claimed.attempt),
        maxAttempts: options.maxAttempts ?? 8,
        deadLetterAudit: {
          id: createId('audit'),
          tenantId: claimed.tenantId,
          action: 'agent.token.revocation.dead_letter',
          resourceType: 'admin_agent_token_revocation_outbox',
          resourceId: claimed.id,
          severity: 'critical',
          actorType: 'system',
          actorSub: 'system:ar-management-agent-token-revoker',
          grantId: claimed.grantId,
          metadata: {
            attempt_count: claimed.attempt,
            processing_fence: claimed.fence,
            family_count: claimed.familyIds.length,
          },
          createdAt: failedAt,
        },
      });
      if (outcome === 'dead_letter') summary.deadLetter += 1;
      else if (outcome === 'retry_scheduled') summary.retryScheduled += 1;
      else summary.lostRace += 1;
    }
  }
  return summary;
}

export async function processScheduledAgentTokenRevocations(
  env: Env,
  log: AgentTokenRevocationLogger
): Promise<AgentTokenRevocationSummary | null> {
  try {
    const repository = new AdminAgentAccessRepository(
      requireDedicatedAdminDatabaseAdapter(env, 'agent-token-revocation')
    );
    const summary = await processAgentTokenRevocationOutbox(
      repository,
      new CloudflareRefreshFamilyRevoker(env)
    );
    log.info('Agent refresh family revocation completed', { ...summary });
    return summary;
  } catch (error) {
    log.error('Agent refresh family revocation failed', {}, error as Error);
    return null;
  }
}
