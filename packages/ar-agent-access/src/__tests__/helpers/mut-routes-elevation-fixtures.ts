import { vi, type Mock } from 'vitest';
import {
  computeAgentElevationArgsHash,
  type AdminAgentAccessRepository,
  type AgentElevationChallengeRecord,
  type AgentGrantContract,
} from '../../core';
import type { AgentElevationResolutionRequest, SecretKeyProviderPort } from '../../platform/ports';
import { CloudflareAgentElevationAdapter } from '../../platform/cloudflare/elevation';

export const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-2',
  permissions: ['admin:users:suspend'],
  scopes: ['agent:write'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 1,
  generation: 1,
  status: 'active',
  delegationMode: 'user_consent',
};

export const baseRequest: AgentElevationResolutionRequest = {
  actor: {
    mode: 'mode_a',
    sub: 'client:client-1',
    assurance: 'confidential_client',
    tokenBinding: 'bearer',
    clientId: 'client-1',
  },
  grant,
  tool: {
    id: 'admin.write.users.suspend',
    name: 'suspend_user',
    title: 'Suspend user',
    description: 'Suspend one user.',
    contractVersion: '1',
    requiredPermissions: ['admin:users:suspend'],
    riskLevel: 'high',
    requiredScope: 'agent:write',
    schemaDigest: 'sha256:test',
    inputSchema: { type: 'object' },
  },
  resource: { tenantId: 'tenant-1', resourceId: 'user-1' },
  input: { user_id: 'user-1', reason_code: 'security_incident' },
  issuerOrigin: 'https://tenant-1.authrim.example',
  correlationId: 'correlation-1',
};

export async function encryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export const keys: SecretKeyProviderPort = {
  getEncryptionKey: encryptionKey,
  getSigningKey: encryptionKey,
};

export function argsHashFor(request: AgentElevationResolutionRequest = baseRequest) {
  return computeAgentElevationArgsHash({
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
}

export async function challengeFor(
  overrides: Partial<AgentElevationChallengeRecord> = {}
): Promise<AgentElevationChallengeRecord> {
  return {
    id: 'ael-1',
    tenantId: 'tenant-1',
    grantId: 'grant-1',
    userId: 'admin-2',
    actorSub: 'client:client-1',
    clientId: 'client-1',
    toolName: 'admin.write.users.suspend',
    toolSchemaVersion: '1',
    argsHash: await argsHashFor(),
    confirmSummaryRedacted: 'Approve Suspend user for resource user-1?',
    status: 'pending',
    executionAttempt: 0,
    executionFence: 0,
    createdAt: 1_000,
    expiresAt: 301_000,
    ...overrides,
  };
}

type MockedMethod =
  | 'getElevationChallenge'
  | 'findActiveElevationChallenge'
  | 'createElevation'
  | 'claimElevationExecution'
  | 'expireUnclaimedElevation'
  | 'completeElevationExecution'
  | 'getElevationApprovalDecision'
  | 'decideElevation'
  | 'getActiveDelegatorPermissions';

export type RepositoryMock = AdminAgentAccessRepository & {
  [K in MockedMethod]: Mock<AdminAgentAccessRepository[K]>;
};

export function repositoryMock(overrides: Record<string, unknown> = {}): RepositoryMock {
  return {
    getElevationChallenge: vi.fn(async () => null),
    findActiveElevationChallenge: vi.fn(async () => null),
    createElevation: vi.fn(async () => undefined),
    claimElevationExecution: vi.fn(async () => null),
    expireUnclaimedElevation: vi.fn(async () => true),
    completeElevationExecution: vi.fn(async () => true),
    getElevationApprovalDecision: vi.fn(async () => null),
    decideElevation: vi.fn(async () => true),
    getActiveDelegatorPermissions: vi.fn(async () => ['admin:users:suspend']),
    ...overrides,
  } as unknown as RepositoryMock;
}

export function adapterFor(
  repository: AdminAgentAccessRepository,
  options: Partial<ConstructorParameters<typeof CloudflareAgentElevationAdapter>[2]> = {}
) {
  return new CloudflareAgentElevationAdapter(repository, keys, {
    payloadKeyId: 'key-v1',
    now: () => 1_000,
    generateId: (prefix) => `${prefix}-1`,
    ...options,
  });
}
