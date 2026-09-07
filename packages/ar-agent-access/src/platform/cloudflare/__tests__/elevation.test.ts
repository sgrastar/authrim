import { describe, expect, it, vi } from 'vitest';
import type {
  AdminAgentAccessRepository,
  AgentElevationChallengeRecord,
  AgentGrantContract,
} from '../../../core';
import { CloudflareAgentElevationAdapter, decryptCloudflareAgentJson } from '../elevation';

const grant: AgentGrantContract = {
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

const request = {
  actor: {
    mode: 'mode_a' as const,
    sub: 'client:client-1',
    assurance: 'confidential_client' as const,
    tokenBinding: 'bearer' as const,
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
    riskLevel: 'high' as const,
    requiredScope: 'agent:write' as const,
    schemaDigest: 'sha256:test',
    inputSchema: { type: 'object' },
  },
  resource: { tenantId: 'tenant-1', resourceId: 'user-1' },
  input: { user_id: 'user-1', reason_code: 'security_incident' },
  issuerOrigin: 'https://tenant-1.authrim.example',
  correlationId: 'correlation-1',
};

async function encryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function repositoryMock(overrides: Record<string, unknown> = {}) {
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
  } as unknown as AdminAgentAccessRepository;
}

describe('CloudflareAgentElevationAdapter', () => {
  it('creates an encrypted operation-bound challenge and returns a same-origin URL elicitation', async () => {
    const repository = repositoryMock();
    const adapter = new CloudflareAgentElevationAdapter(
      repository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      {
        payloadKeyId: 'key-v1',
        now: () => 1_000,
        generateId: () => 'ael-1',
      }
    );

    await expect(adapter.resolve(request)).resolves.toMatchObject({
      status: 'required',
      challengeId: 'ael-1',
      url: 'https://tenant-1.authrim.example/admin/agent-access/elevations/ael-1',
      expiresAt: 301_000,
    });
    const createCall = vi.mocked(repository.createElevation).mock.calls[0][0];
    expect(createCall).toMatchObject({
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      payloadKeyVersion: 'key-v1',
    });
    expect(createCall.argsEnvelope).not.toContain('security_incident');
    expect(JSON.parse(createCall.argsEnvelope)).toMatchObject({
      v: 1,
      kid: 'key-v1',
      aad_digest: expect.any(String),
    });
    const keys = { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey };
    const aad = {
      purpose: 'authrim-agent-elevation-payload-v1',
      tenant_id: 'tenant-1',
      grant_id: 'grant-1',
      elevation_id: 'ael-1',
      actor_sub: 'client:client-1',
      tool_name: 'admin.write.users.suspend',
      tool_schema_version: '1',
      payload_kind: 'arguments',
    };
    await expect(decryptCloudflareAgentJson(createCall.argsEnvelope, keys, aad)).resolves.toEqual(
      request.input
    );
    await expect(
      decryptCloudflareAgentJson(createCall.argsEnvelope, keys, {
        ...aad,
        tenant_id: 'tenant-2',
      })
    ).rejects.toThrow('context mismatch');
  });

  it('claims only an exact approved challenge and completes with the opaque owner token', async () => {
    const firstRepository = repositoryMock();
    const firstAdapter = new CloudflareAgentElevationAdapter(
      firstRepository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      { payloadKeyId: 'key-v1', now: () => 1_000, generateId: () => 'ael-1' }
    );
    await firstAdapter.resolve(request);
    const created = vi.mocked(firstRepository.createElevation).mock.calls[0][0];
    const challenge: AgentElevationChallengeRecord = {
      id: 'ael-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsHash: created.argsHash,
      confirmSummaryRedacted: created.confirmSummaryRedacted,
      status: 'approved',
      executionAttempt: 0,
      executionFence: 0,
      createdAt: 1_000,
      expiresAt: 301_000,
    };
    const repository = repositoryMock({
      getElevationChallenge: vi.fn(async () => challenge),
      claimElevationExecution: vi.fn(async () => ({
        id: 'ael-1',
        attempt: 1,
        fence: 1,
        ownerId: 'aex-1',
        leaseExpiresAt: 61_000,
      })),
    });
    const adapter = new CloudflareAgentElevationAdapter(
      repository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      { payloadKeyId: 'key-v1', now: () => 1_000, generateId: () => 'aex-1' }
    );

    const resolution = await adapter.resolve({ ...request, challengeId: 'ael-1' });
    expect(resolution).toMatchObject({
      status: 'authorized',
      executionToken: 'aex-1',
      idempotencyKey: 'agent-elevation:ael-1:1:1',
    });
    await expect(
      adapter.complete({
        tenantId: 'tenant-1',
        challengeId: 'ael-1',
        executionAttempt: 1,
        executionFence: 1,
        executionToken: 'aex-1',
        status: 'consumed',
        result: { status: 'suspended' },
        correlationId: 'correlation-1',
      })
    ).resolves.toBe(true);
    expect(repository.completeElevationExecution).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'aex-1', status: 'consumed' })
    );
  });

  it('rejects a challenge replay with different arguments', async () => {
    const challenge: AgentElevationChallengeRecord = {
      id: 'ael-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsHash: 'different-hash',
      confirmSummaryRedacted: 'Approve?',
      status: 'approved',
      executionAttempt: 0,
      executionFence: 0,
      createdAt: 1_000,
      expiresAt: 301_000,
    };
    const repository = repositoryMock({ getElevationChallenge: vi.fn(async () => challenge) });
    const adapter = new CloudflareAgentElevationAdapter(
      repository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      { payloadKeyId: 'key-v1', now: () => 1_000 }
    );

    await expect(adapter.resolve({ ...request, challengeId: 'ael-1' })).rejects.toThrow(
      'does not match'
    );
    expect(repository.claimElevationExecution).not.toHaveBeenCalled();
  });

  it('retires an expired unclaimed challenge before issuing a replacement', async () => {
    const expired: AgentElevationChallengeRecord = {
      id: 'ael-expired',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsHash: '',
      confirmSummaryRedacted: 'Approve?',
      status: 'pending',
      executionAttempt: 0,
      executionFence: 0,
      createdAt: 1_000,
      expiresAt: 1_500,
    };
    const repository = repositoryMock();
    const adapter = new CloudflareAgentElevationAdapter(
      repository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      {
        payloadKeyId: 'key-v1',
        now: () => 2_000,
        generateId: (prefix) => `${prefix}-replacement`,
      }
    );
    await adapter.resolve(request);
    const argsHash = vi.mocked(repository.createElevation).mock.calls[0][0].argsHash;
    expired.argsHash = argsHash;
    vi.mocked(repository.createElevation).mockClear();
    vi.mocked(repository.findActiveElevationChallenge)
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(null);

    await expect(adapter.resolve(request)).resolves.toMatchObject({
      status: 'required',
      challengeId: 'ael-replacement',
    });
    expect(repository.expireUnclaimedElevation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        challengeId: 'ael-expired',
        audit: expect.objectContaining({ action: 'agent.elevation.expired' }),
      })
    );
    expect(repository.createElevation).toHaveBeenCalledOnce();
  });

  it('expires but never replaces an explicitly presented stale challenge', async () => {
    const firstRepository = repositoryMock();
    const firstAdapter = new CloudflareAgentElevationAdapter(
      firstRepository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      { payloadKeyId: 'key-v1', now: () => 1_000, generateId: () => 'ael-expired' }
    );
    await firstAdapter.resolve(request);
    const created = vi.mocked(firstRepository.createElevation).mock.calls[0][0];
    const expired: AgentElevationChallengeRecord = {
      id: 'ael-expired',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsHash: created.argsHash,
      confirmSummaryRedacted: created.confirmSummaryRedacted,
      status: 'approved',
      executionAttempt: 0,
      executionFence: 0,
      createdAt: 1_000,
      expiresAt: 1_500,
    };
    const repository = repositoryMock({ getElevationChallenge: vi.fn(async () => expired) });
    const adapter = new CloudflareAgentElevationAdapter(
      repository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      { payloadKeyId: 'key-v1', now: () => 2_000 }
    );

    await expect(adapter.resolve({ ...request, challengeId: expired.id })).rejects.toThrow(
      'expired'
    );
    expect(repository.expireUnclaimedElevation).toHaveBeenCalledOnce();
    expect(repository.createElevation).not.toHaveBeenCalled();
  });

  it('promotes an approved CIBA workflow through the same audited one-time challenge', async () => {
    const firstRepository = repositoryMock();
    const firstAdapter = new CloudflareAgentElevationAdapter(
      firstRepository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      { payloadKeyId: 'key-v1', now: () => 1_000, generateId: () => 'ael-1' }
    );
    await firstAdapter.resolve(request);
    const created = vi.mocked(firstRepository.createElevation).mock.calls[0][0];
    const pending: AgentElevationChallengeRecord = {
      id: 'ael-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsHash: created.argsHash,
      confirmSummaryRedacted: created.confirmSummaryRedacted,
      status: 'pending',
      approvalRequestId: 'approval-request-1',
      approvalArtifactId: 'artifact-1',
      executionAttempt: 0,
      executionFence: 0,
      createdAt: 1_000,
      expiresAt: 301_000,
    };
    const approved = { ...pending, status: 'approved' as const };
    const repository = repositoryMock({
      getElevationChallenge: vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(approved),
      getElevationApprovalDecision: vi.fn(async () => ({
        status: 'approved',
        approverId: 'admin-3',
      })),
      claimElevationExecution: vi.fn(async () => ({
        id: 'ael-1',
        attempt: 1,
        fence: 1,
        ownerId: 'aex-1',
        leaseExpiresAt: 61_000,
      })),
    });
    const adapter = new CloudflareAgentElevationAdapter(
      repository,
      { getEncryptionKey: encryptionKey, getSigningKey: encryptionKey },
      { payloadKeyId: 'key-v1', now: () => 1_000, generateId: (prefix) => `${prefix}-1` }
    );
    await expect(adapter.resolve({ ...request, challengeId: 'ael-1' })).resolves.toMatchObject({
      status: 'authorized',
    });
    expect(repository.decideElevation).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'approved',
        approverType: 'approval',
        approverId: 'admin-3',
        audit: expect.objectContaining({
          action: 'agent.elevation.granted',
          metadata: expect.objectContaining({ approval_mode: 'ciba' }),
        }),
      })
    );
  });
});
