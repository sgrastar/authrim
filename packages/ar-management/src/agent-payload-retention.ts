import { AgentBulkRepository, AgentConfigurationRepository } from '@authrim/ar-agent-access/core';
import {
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

export interface AgentPayloadRetentionSummary {
  configurationPlansPurged: number;
  bulkPlansPurged: number;
}

interface AgentPayloadRetentionLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
}

export async function purgeExpiredAgentPayloads(
  adapter: DatabaseAdapter,
  now = Date.now(),
  limit = 100
): Promise<AgentPayloadRetentionSummary> {
  const configuration = new AgentConfigurationRepository(adapter);
  const bulk = new AgentBulkRepository(adapter);
  const [configurationPlansPurged, bulkPlansPurged] = await Promise.all([
    configuration.purgeExpiredPayloads(now, limit),
    bulk.purgePayloads(now, limit),
  ]);
  return { configurationPlansPurged, bulkPlansPurged };
}

export async function processScheduledAgentPayloadRetention(
  env: Env,
  log: AgentPayloadRetentionLogger
): Promise<AgentPayloadRetentionSummary | null> {
  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(env, 'agent-payload-retention');
    const summary = await purgeExpiredAgentPayloads(adapter);
    log.info('Agent payload retention completed', { ...summary });
    return summary;
  } catch (error) {
    log.error('Agent payload retention failed', {}, error as Error);
    return null;
  }
}
