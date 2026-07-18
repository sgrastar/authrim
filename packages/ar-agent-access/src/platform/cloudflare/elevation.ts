import {
  AdminAgentAccessRepository,
  canonicalizeJson,
  computeAgentElevationArgsHash,
  sha256Base64Url,
  type AgentElevationChallengeRecord,
  type JsonValue,
} from '../../core';
import { hasAdminPermission } from '@authrim/ar-lib-core/types/admin-user';
import type {
  AgentElevationCompletion,
  AgentElevationPort,
  AgentElevationResolution,
  AgentElevationResolutionRequest,
  SecretKeyProviderPort,
} from '../ports';

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PAYLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const EXECUTION_LEASE_MS = 60 * 1000;
const MAX_ENCRYPTED_JSON_BYTES = 64 * 1024;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError('Invalid encrypted payload encoding');
  const base64 = value
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function encryptCloudflareAgentJson(
  value: JsonValue,
  keys: SecretKeyProviderPort,
  keyId: string,
  aad: JsonValue
): Promise<string> {
  const plaintext = new TextEncoder().encode(canonicalizeJson(value));
  const additionalData = new TextEncoder().encode(canonicalizeJson(aad));
  if (plaintext.byteLength > MAX_ENCRYPTED_JSON_BYTES) {
    throw new TypeError('Agent elevation payload exceeds the encrypted payload limit');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keys.getEncryptionKey(keyId);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext)
  );
  return JSON.stringify({
    v: 1,
    kid: keyId,
    alg: 'A256GCM',
    aad_digest: await sha256Base64Url(canonicalizeJson(aad)),
    iv: base64Url(iv),
    ciphertext: base64Url(ciphertext),
  });
}

export async function decryptCloudflareAgentJson(
  envelope: string,
  keys: SecretKeyProviderPort,
  aad: JsonValue
): Promise<JsonValue> {
  const parsed: unknown = JSON.parse(envelope);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).v !== 1 ||
    (parsed as Record<string, unknown>).alg !== 'A256GCM' ||
    typeof (parsed as Record<string, unknown>).kid !== 'string' ||
    typeof (parsed as Record<string, unknown>).aad_digest !== 'string' ||
    typeof (parsed as Record<string, unknown>).iv !== 'string' ||
    typeof (parsed as Record<string, unknown>).ciphertext !== 'string'
  ) {
    throw new TypeError('Invalid Agent elevation payload envelope');
  }
  const record = parsed as Record<string, string>;
  const canonicalAad = canonicalizeJson(aad);
  if (record.aad_digest !== (await sha256Base64Url(canonicalAad))) {
    throw new TypeError('Agent elevation payload context mismatch');
  }
  const key = await keys.getEncryptionKey(record.kid);
  const additionalData = new TextEncoder().encode(canonicalAad);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(record.iv), additionalData },
    key,
    fromBase64Url(record.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as JsonValue;
}

function assertIssuerOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    (url.protocol !== 'https:' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== '[::1]') ||
    url.username ||
    url.password
  ) {
    throw new TypeError('Agent elevation issuer origin is invalid');
  }
  return url.origin;
}

function elevationUrl(issuerOrigin: string, challengeId: string): string {
  return `${assertIssuerOrigin(issuerOrigin)}/admin/agent-access/elevations/${encodeURIComponent(challengeId)}`;
}

function sameChallenge(
  challenge: AgentElevationChallengeRecord,
  request: AgentElevationResolutionRequest,
  argsHash: string
): boolean {
  return (
    challenge.tenantId === request.grant.tenantId &&
    challenge.grantId === request.grant.grantId &&
    challenge.userId === request.grant.delegatorId &&
    challenge.actorSub === request.actor.sub &&
    challenge.clientId === request.actor.clientId &&
    challenge.toolName === request.tool.id &&
    challenge.toolSchemaVersion === request.tool.contractVersion &&
    challenge.argsHash === argsHash
  );
}

export interface CloudflareAgentElevationAdapterOptions {
  payloadKeyId: string;
  now?: () => number;
  generateId?: (prefix: string) => string;
  challengeTtlMs?: number;
  payloadRetentionMs?: number;
}

/** Cloudflare persistence/crypto adapter for the platform-neutral operation-bound elevation port. */
export class CloudflareAgentElevationAdapter implements AgentElevationPort {
  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;
  private readonly challengeTtlMs: number;
  private readonly payloadRetentionMs: number;

  constructor(
    private readonly repository: AdminAgentAccessRepository,
    private readonly keys: SecretKeyProviderPort,
    private readonly options: CloudflareAgentElevationAdapterOptions
  ) {
    this.now = options.now ?? (() => Date.now());
    this.generateId = options.generateId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
    this.challengeTtlMs = Math.min(
      DEFAULT_CHALLENGE_TTL_MS,
      Math.max(30_000, options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS)
    );
    this.payloadRetentionMs = Math.max(
      this.challengeTtlMs,
      options.payloadRetentionMs ?? DEFAULT_PAYLOAD_RETENTION_MS
    );
  }

  private async encrypt(value: JsonValue, aad: JsonValue): Promise<string> {
    return encryptCloudflareAgentJson(value, this.keys, this.options.payloadKeyId, aad);
  }

  private required(
    challenge: AgentElevationChallengeRecord,
    issuerOrigin: string
  ): AgentElevationResolution {
    return {
      status: 'required',
      challengeId: challenge.id,
      url: elevationUrl(issuerOrigin, challenge.id),
      message: challenge.confirmSummaryRedacted,
      expiresAt: challenge.expiresAt,
    };
  }

  private async synchronizeApprovalWorkflow(
    challenge: AgentElevationChallengeRecord,
    requiredPermissions: readonly string[],
    now: number
  ): Promise<AgentElevationChallengeRecord> {
    if (challenge.status !== 'pending' || !challenge.approvalRequestId) return challenge;
    const decision = await this.repository.getElevationApprovalDecision(
      challenge.tenantId,
      challenge.id
    );
    if (!decision || (decision.status !== 'approved' && decision.status !== 'denied')) {
      return challenge;
    }
    const approverId = decision.approverId;
    if (!approverId) return challenge;
    let synchronizedDecision: 'approved' | 'denied' = decision.status;
    let invalidationReason: string | undefined;
    if (decision.status === 'approved') {
      const approverPermissions = await this.repository.getActiveDelegatorPermissions(
        challenge.tenantId,
        approverId,
        now
      );
      if (
        !approverPermissions ||
        requiredPermissions.some(
          (permission) => !hasAdminPermission(approverPermissions, permission)
        )
      ) {
        synchronizedDecision = 'denied';
        invalidationReason = 'approver_permission_changed';
      }
    }
    await this.repository.decideElevation({
      tenantId: challenge.tenantId,
      challengeId: challenge.id,
      decision: synchronizedDecision,
      approverType: 'approval',
      approverId,
      now,
      audit: {
        id: this.generateId('audit'),
        tenantId: challenge.tenantId,
        adminUserId: approverId,
        action:
          synchronizedDecision === 'approved'
            ? 'agent.elevation.granted'
            : 'agent.elevation.denied',
        resourceType: 'agent_elevation',
        resourceId: challenge.id,
        severity: synchronizedDecision === 'approved' ? 'warn' : 'info',
        result: 'success',
        actorType: 'admin_user',
        actorSub: `admin_user:${approverId}`,
        grantId: challenge.grantId,
        elevationId: challenge.id,
        mcpTool: challenge.toolName,
        metadata: {
          approval_mode: 'ciba',
          approval_request_id: challenge.approvalRequestId,
          args_hash: challenge.argsHash,
          ...(invalidationReason ? { invalidation_reason: invalidationReason } : {}),
        },
        createdAt: now,
      },
    });
    return (
      (await this.repository.getElevationChallenge(challenge.tenantId, challenge.id)) ?? challenge
    );
  }

  async resolve(request: AgentElevationResolutionRequest): Promise<AgentElevationResolution> {
    const now = this.now();
    const argsHash = await computeAgentElevationArgsHash({
      purpose: 'authrim-mcp-elevation-v1',
      tenant_id: request.grant.tenantId,
      grant_id: request.grant.grantId,
      delegator_id: request.grant.delegatorId,
      actor_sub: request.actor.sub,
      client_id: request.actor.clientId,
      tool_name: request.tool.id,
      tool_schema_version: request.tool.contractVersion,
      args: request.input,
    });
    let challenge = request.challengeId
      ? await this.repository.getElevationChallenge(request.grant.tenantId, request.challengeId)
      : await this.repository.findActiveElevationChallenge({
          tenantId: request.grant.tenantId,
          grantId: request.grant.grantId,
          actorSub: request.actor.sub,
          toolName: request.tool.id,
          argsHash,
        });

    if (challenge && challenge.expiresAt <= now) {
      const expiredChallenge = challenge;
      await this.repository.expireUnclaimedElevation({
        tenantId: expiredChallenge.tenantId,
        challengeId: expiredChallenge.id,
        expiredAt: now,
        audit: {
          id: this.generateId('audit'),
          tenantId: expiredChallenge.tenantId,
          action: 'agent.elevation.expired',
          resourceType: 'agent_elevation',
          resourceId: expiredChallenge.id,
          severity: 'info',
          result: 'success',
          actorType: 'system',
          actorSub: 'system:agent-elevation-expiry',
          grantId: expiredChallenge.grantId,
          elevationId: expiredChallenge.id,
          mcpTool: expiredChallenge.toolName,
          metadata: {
            reason: 'challenge_ttl_elapsed',
            expires_at: expiredChallenge.expiresAt,
          },
          createdAt: now,
        },
      });
      if (request.challengeId) throw new TypeError('Agent elevation challenge expired');
      challenge = await this.repository.findActiveElevationChallenge({
        tenantId: request.grant.tenantId,
        grantId: request.grant.grantId,
        actorSub: request.actor.sub,
        toolName: request.tool.id,
        argsHash,
      });
    }

    if (challenge) {
      if (!sameChallenge(challenge, request, argsHash)) {
        throw new TypeError('Agent elevation challenge does not match this operation');
      }
      if (challenge.expiresAt <= now) throw new TypeError('Agent elevation challenge expired');
      challenge = await this.synchronizeApprovalWorkflow(
        challenge,
        request.tool.requiredPermissions,
        now
      );
      if (challenge.status === 'pending') return this.required(challenge, request.issuerOrigin);
      if (challenge.status !== 'approved' || !request.challengeId) {
        throw new TypeError('Agent elevation challenge is not claimable');
      }
      const executionToken = this.generateId('aex');
      const claimed = await this.repository.claimElevationExecution(
        request.grant.tenantId,
        challenge.id,
        executionToken,
        now,
        now + EXECUTION_LEASE_MS
      );
      if (!claimed) throw new TypeError('Agent elevation challenge was already claimed');
      return {
        status: 'authorized',
        challengeId: challenge.id,
        executionAttempt: claimed.attempt,
        executionFence: claimed.fence,
        executionToken,
        idempotencyKey: `agent-elevation:${challenge.id}:${claimed.attempt}:${claimed.fence}`,
      };
    }

    const challengeId = this.generateId('ael');
    const expiresAt = now + this.challengeTtlMs;
    const target = request.resource.resourceId
      ? `resource ${request.resource.resourceId}`
      : 'the selected resource';
    const confirmSummary = `Approve ${request.tool.title} for ${target}?`;
    try {
      await this.repository.createElevation({
        id: challengeId,
        tenantId: request.grant.tenantId,
        grantId: request.grant.grantId,
        userId: request.grant.delegatorId,
        actorSub: request.actor.sub,
        clientId: request.actor.clientId,
        toolName: request.tool.id,
        toolSchemaVersion: request.tool.contractVersion,
        argsEnvelope: await this.encrypt(request.input, {
          purpose: 'authrim-agent-elevation-payload-v1',
          tenant_id: request.grant.tenantId,
          grant_id: request.grant.grantId,
          elevation_id: challengeId,
          actor_sub: request.actor.sub,
          tool_name: request.tool.id,
          tool_schema_version: request.tool.contractVersion,
          payload_kind: 'arguments',
        }),
        argsHash,
        confirmSummaryRedacted: confirmSummary,
        payloadKeyVersion: this.options.payloadKeyId,
        payloadPurgeAt: now + this.payloadRetentionMs,
        createdAt: now,
        expiresAt,
      });
    } catch (error) {
      challenge = await this.repository.findActiveElevationChallenge({
        tenantId: request.grant.tenantId,
        grantId: request.grant.grantId,
        actorSub: request.actor.sub,
        toolName: request.tool.id,
        argsHash,
      });
      if (!challenge) throw error;
      return this.required(challenge, request.issuerOrigin);
    }
    return {
      status: 'required',
      challengeId,
      url: elevationUrl(request.issuerOrigin, challengeId),
      message: confirmSummary,
      expiresAt,
    };
  }

  async complete(completion: AgentElevationCompletion): Promise<boolean> {
    let resultEnvelope: string | undefined;
    let resultDigest: string | undefined;
    if (completion.result !== undefined) {
      const canonical = canonicalizeJson(completion.result);
      resultDigest = await sha256Base64Url(canonical);
      if (new TextEncoder().encode(canonical).byteLength <= MAX_ENCRYPTED_JSON_BYTES) {
        const challenge = await this.repository.getElevationChallenge(
          completion.tenantId,
          completion.challengeId
        );
        if (!challenge) return false;
        resultEnvelope = await this.encrypt(completion.result, {
          purpose: 'authrim-agent-elevation-payload-v1',
          tenant_id: challenge.tenantId,
          grant_id: challenge.grantId,
          elevation_id: challenge.id,
          actor_sub: challenge.actorSub,
          tool_name: challenge.toolName,
          tool_schema_version: challenge.toolSchemaVersion,
          payload_kind: 'execution_result',
        });
      }
    }
    return this.repository.completeElevationExecution({
      tenantId: completion.tenantId,
      challengeId: completion.challengeId,
      ownerId: completion.executionToken,
      attempt: completion.executionAttempt,
      fence: completion.executionFence,
      status: completion.status,
      resultEnvelope,
      resultDigest,
      completedAt: this.now(),
    });
  }
}
