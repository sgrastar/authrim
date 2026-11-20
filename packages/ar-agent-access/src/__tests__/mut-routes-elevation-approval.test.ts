import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeJson,
  sha256Base64Url,
  type AgentElevationChallengeRecord,
  type ClaimedAgentElevation,
} from '../core';
import { decryptCloudflareAgentJson } from '../platform/cloudflare/elevation';
import {
  adapterFor,
  baseRequest,
  challengeFor,
  keys,
  repositoryMock,
} from './helpers/mut-routes-elevation-fixtures';

const CLAIM: ClaimedAgentElevation = {
  id: 'ael-1',
  attempt: 1,
  fence: 1,
  ownerId: 'aex-1',
  leaseExpiresAt: 61_000,
};

async function cibaSetup(
  decision: unknown,
  options: {
    permissions?: string[] | null;
    refetched?: Partial<AgentElevationChallengeRecord> | null;
    challenge?: Partial<AgentElevationChallengeRecord>;
  } = {}
) {
  const pending = await challengeFor({
    approvalRequestId: 'approval-1',
    ...options.challenge,
  });
  const refetched =
    options.refetched === null ? null : { ...pending, ...(options.refetched ?? {}) };
  const repository = repositoryMock({
    findActiveElevationChallenge: vi.fn(async () => pending),
    getElevationChallenge: vi.fn(async () => refetched),
    getElevationApprovalDecision: vi.fn(async () => decision),
    getActiveDelegatorPermissions: vi.fn(async () =>
      options.permissions === undefined ? ['admin:users:suspend'] : options.permissions
    ),
  });
  return { repository, adapter: adapterFor(repository), pending };
}

function expectedAudit(decision: 'approved' | 'denied', extra: Record<string, unknown> = {}) {
  return {
    id: 'audit-1',
    tenantId: 'tenant-1',
    adminUserId: 'admin-3',
    action: decision === 'approved' ? 'agent.elevation.granted' : 'agent.elevation.denied',
    resourceType: 'agent_elevation',
    resourceId: 'ael-1',
    severity: decision === 'approved' ? 'warn' : 'info',
    result: 'success',
    actorType: 'admin_user',
    actorSub: 'admin_user:admin-3',
    grantId: 'grant-1',
    elevationId: 'ael-1',
    mcpTool: 'admin.write.users.suspend',
    metadata: {
      approval_mode: 'ciba',
      approval_request_id: 'approval-1',
      args_hash: expect.any(String) as string,
      ...extra,
    },
    createdAt: 1_000,
  };
}

describe('CIBA approval synchronization', () => {
  it('records an approval with the exact audit and the approver permissions check', async () => {
    const { repository, adapter, pending } = await cibaSetup(
      { status: 'approved', approverId: 'admin-3' },
      { refetched: { status: 'pending' } }
    );
    await expect(adapter.resolve(baseRequest)).resolves.toMatchObject({ status: 'required' });
    expect(repository.getElevationApprovalDecision).toHaveBeenCalledWith('tenant-1', 'ael-1');
    expect(repository.getActiveDelegatorPermissions).toHaveBeenCalledWith(
      'tenant-1',
      'admin-3',
      1_000
    );
    expect(repository.decideElevation).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      challengeId: 'ael-1',
      decision: 'approved',
      approverType: 'approval',
      approverId: 'admin-3',
      now: 1_000,
      audit: expectedAudit('approved'),
    });
    expect(repository.decideElevation.mock.calls[0][0].audit.metadata.args_hash).toBe(
      pending.argsHash
    );
    expect(repository.getElevationChallenge).toHaveBeenCalledWith('tenant-1', 'ael-1');
  });

  it('records a denial without consulting approver permissions and refuses to claim', async () => {
    const { repository, adapter } = await cibaSetup(
      { status: 'denied', approverId: 'admin-3' },
      { refetched: { status: 'denied' } }
    );
    await expect(adapter.resolve(baseRequest)).rejects.toThrow(
      new TypeError('Agent elevation challenge is not claimable')
    );
    expect(repository.getActiveDelegatorPermissions).not.toHaveBeenCalled();
    expect(repository.decideElevation).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'denied', audit: expectedAudit('denied') })
    );
  });

  it.each([
    ['lost a required permission', ['admin:users:read']],
    ['is no longer an active delegator', null],
  ])('downgrades an approval to a denial when the approver %s', async (_name, permissions) => {
    const { repository, adapter } = await cibaSetup(
      { status: 'approved', approverId: 'admin-3' },
      { permissions, refetched: { status: 'denied' } }
    );
    await expect(adapter.resolve(baseRequest)).rejects.toThrow('not claimable');
    expect(repository.decideElevation).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'denied',
        audit: expectedAudit('denied', { invalidation_reason: 'approver_permission_changed' }),
      })
    );
  });

  it('requires every tool permission from the approver', async () => {
    const { repository, adapter } = await cibaSetup(
      { status: 'approved', approverId: 'admin-3' },
      { permissions: ['admin:users:suspend'], refetched: { status: 'denied' } }
    );
    await expect(
      adapter.resolve({
        ...baseRequest,
        tool: {
          ...baseRequest.tool,
          requiredPermissions: ['admin:users:suspend', 'admin:clients:write'],
        },
      })
    ).rejects.toThrow('not claimable');
    expect(repository.decideElevation.mock.calls[0][0].decision).toBe('denied');
  });

  it('authorizes the presented challenge after a synchronized approval', async () => {
    const { repository, adapter } = await cibaSetup(
      { status: 'approved', approverId: 'admin-3' },
      { refetched: { status: 'approved' } }
    );
    repository.claimElevationExecution.mockResolvedValue(CLAIM);
    await expect(adapter.resolve({ ...baseRequest, challengeId: 'ael-1' })).resolves.toMatchObject({
      status: 'authorized',
      idempotencyKey: 'agent-elevation:ael-1:1:1',
    });
  });

  it('keeps the original challenge when the post-decision reload finds nothing', async () => {
    const pending = await challengeFor({ approvalRequestId: 'approval-1' });
    const repository = repositoryMock({
      getElevationChallenge: vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(null),
      getElevationApprovalDecision: vi.fn(async () => ({ status: 'approved', approverId: 'a' })),
    });
    await expect(
      adapterFor(repository).resolve({ ...baseRequest, challengeId: 'ael-1' })
    ).resolves.toMatchObject({ status: 'required', challengeId: 'ael-1' });
    expect(repository.decideElevation).toHaveBeenCalledOnce();
  });

  it.each([
    ['no decision', null],
    ['a pending decision', { status: 'pending', approverId: 'admin-3' }],
    ['an expired decision', { status: 'expired', approverId: 'admin-3' }],
    ['a cancelled decision', { status: 'cancelled', approverId: 'admin-3' }],
    ['an approval without approver', { status: 'approved' }],
    ['a denial without approver', { status: 'denied', approverId: '' }],
  ])('leaves the challenge pending for %s', async (_name, decision) => {
    const { repository, adapter } = await cibaSetup(decision);
    await expect(adapter.resolve(baseRequest)).resolves.toMatchObject({ status: 'required' });
    expect(repository.decideElevation).not.toHaveBeenCalled();
    expect(repository.getActiveDelegatorPermissions).not.toHaveBeenCalled();
  });

  it('does not consult the approval workflow for non-CIBA or already decided challenges', async () => {
    const direct = await challengeFor();
    const repository = repositoryMock({ findActiveElevationChallenge: vi.fn(async () => direct) });
    await adapterFor(repository).resolve(baseRequest);
    expect(repository.getElevationApprovalDecision).not.toHaveBeenCalled();

    const approved = await challengeFor({ status: 'approved', approvalRequestId: 'approval-1' });
    const second = repositoryMock({
      getElevationChallenge: vi.fn(async () => approved),
      claimElevationExecution: vi.fn(async () => CLAIM),
    });
    await adapterFor(second).resolve({ ...baseRequest, challengeId: 'ael-1' });
    expect(second.getElevationApprovalDecision).not.toHaveBeenCalled();
    expect(second.decideElevation).not.toHaveBeenCalled();
  });
});

const completion = {
  tenantId: 'tenant-1',
  challengeId: 'ael-1',
  executionAttempt: 2,
  executionFence: 3,
  executionToken: 'aex-1',
  status: 'consumed' as const,
  correlationId: 'correlation-1',
};

describe('elevation completion', () => {
  it('completes without a result envelope or digest when there is no result', async () => {
    const repository = repositoryMock();
    await expect(adapterFor(repository, { now: () => 7_000 }).complete(completion)).resolves.toBe(
      true
    );
    expect(repository.getElevationChallenge).not.toHaveBeenCalled();
    expect(repository.completeElevationExecution).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      challengeId: 'ael-1',
      ownerId: 'aex-1',
      attempt: 2,
      fence: 3,
      status: 'consumed',
      resultEnvelope: undefined,
      resultDigest: undefined,
      completedAt: 7_000,
    });
  });

  it('encrypts the result bound to the stored challenge context', async () => {
    const challenge = await challengeFor({ toolSchemaVersion: '1' });
    const repository = repositoryMock({ getElevationChallenge: vi.fn(async () => challenge) });
    const result = { status: 'suspended', user_id: 'user-1' };
    await adapterFor(repository).complete({ ...completion, result });
    expect(repository.getElevationChallenge).toHaveBeenCalledWith('tenant-1', 'ael-1');
    const call = repository.completeElevationExecution.mock.calls[0][0];
    expect(call.resultDigest).toBe(await sha256Base64Url(canonicalizeJson(result)));
    const aad = {
      purpose: 'authrim-agent-elevation-payload-v1',
      tenant_id: 'tenant-1',
      grant_id: 'grant-1',
      elevation_id: 'ael-1',
      actor_sub: 'client:client-1',
      tool_name: 'admin.write.users.suspend',
      tool_schema_version: '1',
      payload_kind: 'execution_result',
    };
    const envelope = call.resultEnvelope;
    if (envelope === undefined) throw new Error('result envelope was not written');
    await expect(decryptCloudflareAgentJson(envelope, keys, aad)).resolves.toEqual(result);
    expect(JSON.parse(envelope)).toMatchObject({ kid: 'key-v1' });
  });

  it('refuses completion when the challenge disappeared', async () => {
    const repository = repositoryMock();
    await expect(
      adapterFor(repository).complete({ ...completion, result: { ok: true } })
    ).resolves.toBe(false);
    expect(repository.completeElevationExecution).not.toHaveBeenCalled();
  });

  it('stores only the digest for results above 64 KiB and encrypts at exactly 64 KiB', async () => {
    const challenge = await challengeFor();
    const repository = repositoryMock({ getElevationChallenge: vi.fn(async () => challenge) });
    const adapter = adapterFor(repository);
    const atLimit = 'r'.repeat(64 * 1024 - 2);
    await adapter.complete({ ...completion, result: atLimit });
    await adapter.complete({ ...completion, result: `${atLimit}r` });
    const [first, second] = repository.completeElevationExecution.mock.calls.map(([c]) => c);
    expect(typeof first.resultEnvelope).toBe('string');
    expect(second.resultEnvelope).toBeUndefined();
    expect(second.resultDigest).toBe(await sha256Base64Url(canonicalizeJson(`${atLimit}r`)));
    expect(repository.getElevationChallenge).toHaveBeenCalledTimes(1);
  });

  it('treats a null result as a result to protect', async () => {
    const challenge = await challengeFor();
    const repository = repositoryMock({ getElevationChallenge: vi.fn(async () => challenge) });
    await adapterFor(repository).complete({ ...completion, result: null });
    const call = repository.completeElevationExecution.mock.calls[0][0];
    expect(call.resultDigest).toBe(await sha256Base64Url('null'));
    expect(typeof call.resultEnvelope).toBe('string');
  });
});
