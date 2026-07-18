import { canonicalizeJson, sha256Base64Url } from './canonical-json';
import type { AgentElevationHashContext, JsonValue } from './types';

export type AgentElevationStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'consumed'
  | 'failed'
  | 'indeterminate'
  | 'expired'
  | 'denied';

export interface AgentElevationExecutionFence {
  challengeId: string;
  attempt: number;
  fence: string;
  leaseExpiresAt: number;
}

export type AgentManagementIdempotencyStatus =
  | {
      status: 'succeeded';
      operation: string;
      requestDigest: string;
      resultEnvelope?: string;
      resultDigest?: string;
    }
  | {
      status: 'failed';
      operation: string;
      requestDigest: string;
      resultEnvelope?: string;
      resultDigest?: string;
    }
  | {
      status: 'in_progress';
      operation: string;
      requestDigest: string;
      leaseExpiresAt: number;
    }
  | {
      status: 'not_found';
    };

export interface AgentManagementIdempotencyLookup {
  tenantId: string;
  idempotencyKey: string;
  executionAttempt: number;
  executionFence: number;
}

export async function computeAgentElevationArgsHash(
  context: AgentElevationHashContext
): Promise<string> {
  const canonicalContext: JsonValue = {
    purpose: context.purpose,
    tenant_id: context.tenant_id,
    grant_id: context.grant_id,
    delegator_id: context.delegator_id,
    actor_sub: context.actor_sub,
    client_id: context.client_id,
    tool_name: context.tool_name,
    tool_schema_version: context.tool_schema_version,
    args: context.args,
  };
  return sha256Base64Url(canonicalizeJson(canonicalContext));
}
