import type { Context, Next } from 'hono';
import {
  canonicalizeJson,
  computeAgentElevationArgsHash,
  AdminAgentAccessRepository,
  sha256Base64Url,
  type JsonObject,
  type JsonValue,
} from '@authrim/ar-agent-access/core';
import {
  decryptCloudflareAgentJson,
  encryptCloudflareAgentJson,
} from '@authrim/ar-agent-access/platform/cloudflare/elevation';
import { CloudflareSecretTextKeyProvider } from '@authrim/ar-agent-access/platform/cloudflare/service-binding';
import {
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

const ELEVATION_KEY = /^agent-elevation:([A-Za-z0-9._~-]{1,128}):(\d+):(\d+)$/u;
const EXECUTION_LEASE_MS = 60 * 1000;

interface StoredAgentExecutionResponse extends JsonObject {
  status: number;
  body: JsonValue;
}

export type AgentElevatedToolInputBuilder = (input: {
  body: JsonObject;
  resourceId?: string;
  tenantId: string;
  request: Request;
}) => JsonObject;

function error(c: Context, status: 400 | 401 | 409 | 503, code: string) {
  return c.json({ error: code }, status);
}

function parseStoredResponse(value: JsonValue): StoredAgentExecutionResponse {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isInteger(value.status) ||
    (value.status as number) < 100 ||
    (value.status as number) > 599 ||
    !('body' in value)
  ) {
    throw new TypeError('Invalid Agent execution response envelope');
  }
  return value as StoredAgentExecutionResponse;
}

/**
 * Target-side durable execution fence for high-risk Agent mutations. Absence of a terminal result
 * is never treated as proof that the owner mutation did not happen.
 */
export function agentElevatedExecutionMiddleware(
  operation: string,
  buildToolInput: AgentElevatedToolInputBuilder = ({ body, resourceId }) => {
    if (!resourceId) throw new TypeError('Agent elevation resource ID is required');
    return { ...body, user_id: resourceId };
  }
) {
  return async (
    c: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>,
    next: Next
  ) => {
    const auth = c.get('adminAuth');
    if (auth?.actorType !== 'agent' || !auth.tenantId || !auth.agentGrantId) {
      return error(c, 401, 'AGENT_EXECUTION_TOKEN_REQUIRED');
    }
    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey) return error(c, 400, 'AGENT_ELEVATION_IDEMPOTENCY_KEY_REQUIRED');
    const match = idempotencyKey.match(ELEVATION_KEY);
    if (!match) return error(c, 400, 'AGENT_ELEVATION_IDEMPOTENCY_KEY_REQUIRED');
    const challengeId = match[1]!;
    const executionAttempt = Number(match[2]);
    const executionFence = Number(match[3]);
    if (!Number.isSafeInteger(executionAttempt) || !Number.isSafeInteger(executionFence)) {
      return error(c, 400, 'AGENT_ELEVATION_IDEMPOTENCY_KEY_INVALID');
    }

    const now = Date.now();
    const repository = new AdminAgentAccessRepository(
      requireDedicatedAdminDatabaseAdapter(c.env, 'agent-elevated-execution')
    );
    const challenge = await repository.getElevationChallenge(auth.tenantId, challengeId);
    if (
      !challenge ||
      challenge.status !== 'executing' ||
      challenge.grantId !== auth.agentGrantId ||
      challenge.actorSub !== auth.actorId ||
      challenge.clientId !== auth.clientId ||
      challenge.toolName !== operation ||
      challenge.executionAttempt !== executionAttempt ||
      challenge.executionFence !== executionFence ||
      !challenge.executionLeaseExpiresAt ||
      challenge.executionLeaseExpiresAt <= now
    ) {
      return error(c, 409, 'AGENT_ELEVATION_EXECUTION_FENCE_MISMATCH');
    }

    let body: JsonValue;
    try {
      body = (await c.req.raw.clone().json()) as JsonValue;
    } catch {
      return error(c, 400, 'AGENT_ELEVATION_REQUEST_BODY_INVALID');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return error(c, 400, 'AGENT_ELEVATION_REQUEST_BODY_INVALID');
    }
    const resourceId = c.req.param('id') || undefined;
    let toolInput: JsonObject;
    try {
      toolInput = buildToolInput({
        body,
        resourceId,
        tenantId: auth.tenantId,
        request: c.req.raw,
      });
    } catch {
      return error(c, 400, 'AGENT_ELEVATION_REQUEST_BODY_INVALID');
    }
    const argsHash = await computeAgentElevationArgsHash({
      purpose: 'authrim-mcp-elevation-v1',
      tenant_id: auth.tenantId,
      grant_id: auth.agentGrantId,
      delegator_id: auth.userId,
      actor_sub: auth.actorId,
      client_id: auth.clientId,
      tool_name: operation,
      tool_schema_version: challenge.toolSchemaVersion,
      args: toolInput,
    });
    if (challenge.userId !== auth.userId || challenge.argsHash !== argsHash) {
      return error(c, 409, 'AGENT_ELEVATION_ARGUMENT_BINDING_MISMATCH');
    }
    const requestDigest = await sha256Base64Url(
      canonicalizeJson({
        operation,
        challenge_id: challengeId,
        resource_id: resourceId ?? null,
        body,
      })
    );
    const resultAad: JsonObject = {
      purpose: 'authrim-agent-management-execution-v1',
      tenant_id: auth.tenantId,
      idempotency_key: idempotencyKey,
      execution_attempt: executionAttempt,
      execution_fence: executionFence,
      operation,
      payload_kind: 'terminal_response',
    };
    const keyVersion = c.env.AGENT_ELEVATION_KEY_VERSION ?? 'v1';
    const keys = new CloudflareSecretTextKeyProvider({
      [keyVersion]: c.env.AGENT_ELEVATION_ENCRYPTION_KEY,
    });
    try {
      await keys.getEncryptionKey(keyVersion);
    } catch {
      return error(c, 503, 'AGENT_ELEVATION_ENCRYPTION_UNAVAILABLE');
    }
    const inserted = await repository.beginManagementExecution({
      tenantId: auth.tenantId,
      idempotencyKey,
      executionAttempt,
      executionFence,
      operation,
      requestDigest,
      leaseExpiresAt: now + EXECUTION_LEASE_MS,
      createdAt: now,
    });
    if (!inserted) {
      const existing = await repository.lookupManagementExecution({
        tenantId: auth.tenantId,
        idempotencyKey,
        executionAttempt,
        executionFence,
      });
      if (existing.status === 'in_progress') {
        if (existing.operation !== operation || existing.requestDigest !== requestDigest) {
          return error(c, 409, 'AGENT_ELEVATION_IDEMPOTENCY_CONFLICT');
        }
        c.header('Retry-After', '1');
        return error(c, 409, 'AGENT_ELEVATION_EXECUTION_IN_PROGRESS');
      }
      if (existing.status === 'not_found' || !existing.resultEnvelope) {
        c.header('X-Authrim-Execution-Indeterminate', 'true');
        return error(c, 503, 'AGENT_ELEVATION_EXECUTION_INDETERMINATE');
      }
      if (existing.operation !== operation || existing.requestDigest !== requestDigest) {
        return error(c, 409, 'AGENT_ELEVATION_IDEMPOTENCY_CONFLICT');
      }
      const stored = parseStoredResponse(
        await decryptCloudflareAgentJson(existing.resultEnvelope, keys, resultAad)
      );
      return new Response(JSON.stringify(stored.body), {
        status: stored.status,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-authrim-execution-replayed': existing.status,
        },
      });
    }

    try {
      await next();
      const response = c.res.clone();
      const responseBody = (await response.json()) as JsonValue;
      const terminalStatus =
        response.status >= 200 && response.status < 300 ? 'succeeded' : 'failed';
      const resultDigest = await sha256Base64Url(canonicalizeJson(responseBody));
      const resultEnvelope = await encryptCloudflareAgentJson(
        { status: response.status, body: responseBody },
        keys,
        keyVersion,
        resultAad
      );
      const completed = await repository.completeManagementExecution({
        tenantId: auth.tenantId,
        idempotencyKey,
        executionAttempt,
        executionFence,
        status: terminalStatus,
        resultEnvelope,
        resultDigest,
        completedAt: Date.now(),
      });
      if (!completed) {
        c.header('X-Authrim-Execution-Indeterminate', 'true');
        c.res = error(c, 503, 'AGENT_ELEVATION_EXECUTION_INDETERMINATE');
        return;
      }
    } catch {
      c.header('X-Authrim-Execution-Indeterminate', 'true');
      c.res = error(c, 503, 'AGENT_ELEVATION_EXECUTION_INDETERMINATE');
    }
  };
}
