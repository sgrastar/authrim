/**
 * Flow State Store Sharding Helper
 *
 * Provides utilities for locating FlowStateStore Durable Objects.
 *
 * DO instance name format: tenant:{tenantId}:flow-state:{sessionId}
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type { Env } from '../types/env';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import { buildDOKey } from './tenant-context';

/**
 * Build FlowStateStore DO instance name.
 *
 * FlowStateStore keeps one runtime state per DO, so the instance must be scoped
 * to both tenant and session. Runtime routing no longer uses shared shard DOs
 * or a configurable flow-state shard count.
 *
 * @param tenantId - Tenant ID
 * @param sessionId - Flow session ID
 * @returns DO instance name
 */
export function buildFlowStateInstanceName(tenantId: string, sessionId: string): string {
  return buildDOKey('flow-state', sessionId, tenantId);
}

/**
 * Get FlowStateStore Durable Object stub for a session ID
 *
 * @param env - Environment with FLOW_STATE_STORE binding
 * @param sessionId - Flow session ID
 * @param tenantId - Tenant ID
 * @returns Object containing DO stub, shard index, and instance name
 */
export async function getFlowStateStoreStub(
  env: Env,
  sessionId: string,
  tenantId: string
): Promise<{
  stub: DurableObjectStub;
  shardIndex: number;
  instanceName: string;
}> {
  if (!env.FLOW_STATE_STORE) {
    throw new Error('FLOW_STATE_STORE binding not configured');
  }

  const instanceName = buildFlowStateInstanceName(tenantId, sessionId);

  const doId = (env.FLOW_STATE_STORE as DurableObjectNamespace).idFromName(instanceName);
  const stub = (env.FLOW_STATE_STORE as DurableObjectNamespace).get(doId);

  return { stub, shardIndex: 0, instanceName };
}

/**
 * Generate a new flow session ID
 *
 * Format: flow_{uuid}
 *
 * @returns New session ID
 */
export function generateFlowSessionId(): string {
  return `flow_${crypto.randomUUID()}`;
}
