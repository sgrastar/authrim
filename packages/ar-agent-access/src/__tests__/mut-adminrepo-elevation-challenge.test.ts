import { describe, expect, it } from 'vitest';
import { mutAudit, mutRepo } from './helpers/mut-adminrepo-adapter';

const challengeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'elev-1',
  tenant_id: 'tenant-1',
  grant_id: 'grant-1',
  user_id: 'admin-1',
  actor_sub: 'agent:x',
  client_id: 'client-1',
  tool_name: 'delete_user',
  tool_schema_version: '1',
  args_hash: 'hash',
  confirm_summary_redacted: 'Delete user',
  status: 'pending',
  execution_attempt: 0,
  execution_fence: 0,
  execution_owner_id: null,
  execution_lease_expires_at: null,
  approval_request_id: null,
  approval_artifact_id: null,
  created_at: 10,
  expires_at: 20,
  ...overrides,
});

const baseRecord = {
  id: 'elev-1',
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  userId: 'admin-1',
  actorSub: 'agent:x',
  clientId: 'client-1',
  toolName: 'delete_user',
  toolSchemaVersion: '1',
  argsHash: 'hash',
  confirmSummaryRedacted: 'Delete user',
  status: 'pending',
  executionAttempt: 0,
  executionFence: 0,
  createdAt: 10,
  expiresAt: 20,
};

describe('elevation challenge persistence', () => {
  it('creates a pending, active challenge with every bound value', async () => {
    const { adapter, repository } = mutRepo();
    await repository.createElevation({
      id: 'elev-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-1',
      actorSub: 'agent:x',
      clientId: 'client-1',
      toolName: 'delete_user',
      toolSchemaVersion: '1',
      argsEnvelope: 'env',
      argsHash: 'hash',
      confirmSummaryRedacted: 'Delete user',
      payloadKeyVersion: 'k1',
      payloadPurgeAt: 30,
      createdAt: 10,
      expiresAt: 20,
    });
    expect(adapter.calls[0].sql).toContain("'pending', 'active', 0, 0, 0, ?, ?, ?, ?)");
    expect(adapter.calls[0].params).toEqual([
      'elev-1',
      'tenant-1',
      'grant-1',
      'admin-1',
      'agent:x',
      'client-1',
      'delete_user',
      '1',
      'env',
      'hash',
      'Delete user',
      'k1',
      30,
      10,
      20,
    ]);
  });

  it('maps a challenge without optional execution or approval fields', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(challengeRow());
    await expect(repository.getElevationChallenge('tenant-1', 'elev-1')).resolves.toStrictEqual(
      baseRecord
    );
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'elev-1']);
    expect(adapter.calls[0].sql).toContain(
      'FROM agent_elevation_challenges WHERE tenant_id = ? AND id = ?'
    );
  });

  it('maps every optional execution and approval field when present', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(
      challengeRow({
        execution_owner_id: 'owner',
        execution_lease_expires_at: 99,
        approval_request_id: 'req',
        approval_artifact_id: 'art',
      })
    );
    await expect(repository.getElevationChallenge('tenant-1', 'elev-1')).resolves.toStrictEqual({
      ...baseRecord,
      executionOwnerId: 'owner',
      executionLeaseExpiresAt: 99,
      approvalRequestId: 'req',
      approvalArtifactId: 'art',
    });
  });

  it('returns null for an unknown challenge', async () => {
    const { repository } = mutRepo();
    await expect(repository.getElevationChallenge('tenant-1', 'x')).resolves.toBeNull();
  });

  it('links an approval request only once', async () => {
    const { adapter, repository } = mutRepo();
    const input = {
      tenantId: 'tenant-1',
      challengeId: 'elev-1',
      approvalRequestId: 'req',
      approvalArtifactId: 'art',
      now: 15,
    };
    await expect(repository.linkElevationApprovalRequest(input)).resolves.toBe(true);
    expect(adapter.calls[0].sql).toContain('AND approval_request_id IS NULL');
    expect(adapter.calls[0].params).toEqual(['req', 'art', 'tenant-1', 'elev-1', 15]);
    adapter.executeResults.push({ rowsAffected: 0, success: true });
    await expect(repository.linkElevationApprovalRequest(input)).resolves.toBe(false);
  });

  it('finds the active challenge for an exact operation and loads it', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ id: 'elev-1' }, challengeRow());
    const input = {
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      actorSub: 'agent:x',
      toolName: 'delete_user',
      argsHash: 'hash',
    };
    await expect(repository.findActiveElevationChallenge(input)).resolves.toMatchObject({
      id: 'elev-1',
    });
    expect(adapter.calls[0].params).toEqual([
      'tenant-1',
      'grant-1',
      'agent:x',
      'delete_user',
      'hash',
    ]);
    expect(adapter.calls[0].sql).toContain("active_args_key = 'active'");
    expect(adapter.calls[1].params).toEqual(['tenant-1', 'elev-1']);
    await expect(repository.findActiveElevationChallenge(input)).resolves.toBeNull();
    expect(adapter.calls).toHaveLength(3);
  });
});

describe('getElevationApprovalDecision', () => {
  async function decide(row: Record<string, unknown> | null) {
    const { adapter, repository } = mutRepo();
    if (row) adapter.queryOneResults.push(row);
    const result = await repository.getElevationApprovalDecision('tenant-1', 'elev-1');
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'elev-1']);
    expect(adapter.calls[0].sql).toContain("a.step_key = 'agent-mcp-elevation'");
    return result;
  }

  it.each<[string, string, string, Record<string, unknown>]>([
    ['approved', 'approved', 'approver', { status: 'approved', approverId: 'approver' }],
    ['approved', 'approved', '', { status: 'approved' }],
    ['pending', 'denied', 'approver', { status: 'denied', approverId: 'approver' }],
    ['denied', 'pending', '', { status: 'denied' }],
    ['expired', 'pending', 'approver', { status: 'expired' }],
    ['pending', 'expired', '', { status: 'expired' }],
    ['cancelled', 'pending', '', { status: 'cancelled' }],
    ['pending', 'cancelled', '', { status: 'cancelled' }],
    ['approved', 'pending', 'approver', { status: 'pending' }],
    ['pending', 'approved', '', { status: 'pending' }],
  ])(
    'maps request %s / approval %s (approver %j)',
    async (request, approval, approver, expected) => {
      await expect(
        decide({ request_status: request, approval_status: approval, approver_id: approver })
      ).resolves.toStrictEqual(expected);
    }
  );

  it('returns null without a linked approval', async () => {
    await expect(decide(null)).resolves.toBeNull();
  });
});

describe('expireUnclaimedElevation', () => {
  const input = (
    audit = mutAudit('audit-exp', { elevationId: 'elev-1', resourceId: 'elev-1' })
  ) => ({
    tenantId: 'tenant-1',
    challengeId: 'elev-1',
    expiredAt: 50,
    audit,
  });

  it.each([
    [
      'tenant',
      mutAudit('a', { tenantId: 'tenant-2', elevationId: 'elev-1', resourceId: 'elev-1' }),
    ],
    ['elevation', mutAudit('a', { elevationId: 'elev-2', resourceId: 'elev-1' })],
    ['resource', mutAudit('a', { elevationId: 'elev-1', resourceId: 'elev-2' })],
  ])('rejects an audit with another %s', async (_name, audit) => {
    const { adapter, repository } = mutRepo();
    await expect(repository.expireUnclaimedElevation(input(audit))).rejects.toThrow(
      new TypeError('Elevation expiration audit does not match the expired challenge')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('returns true without a replay read when both writes apply', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.expireUnclaimedElevation(input())).resolves.toBe(true);
    expect(adapter.batches[0][0].params).toEqual([50, 'audit-exp', 'tenant-1', 'elev-1', 50]);
    expect(adapter.calls).toHaveLength(0);
  });

  it.each([[[0, 1]], [[1, 0]]])(
    'falls back to the replay read when rows affected are %j',
    async (affected) => {
      const { adapter, repository } = mutRepo();
      adapter.batchRowsAffected.push(affected);
      await expect(repository.expireUnclaimedElevation(input())).resolves.toBe(false);
      expect(adapter.calls[0].params).toEqual(['tenant-1', 'elev-1', 'audit-exp']);
      adapter.batchRowsAffected.push(affected);
      adapter.queryOneResults.push({ terminal_transition_id: 'audit-exp' });
      await expect(repository.expireUnclaimedElevation(input())).resolves.toBe(true);
    }
  );
});

describe('decideElevation and reconcileIndeterminateElevation', () => {
  const decision = {
    tenantId: 'tenant-1',
    challengeId: 'elev-1',
    decision: 'denied' as const,
    approverType: 'approval' as const,
    approverId: 'approver',
    now: 15,
    audit: mutAudit('audit-dec'),
  };

  it('records a decision only when both the transition and its audit apply', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.decideElevation(decision)).resolves.toBe(true);
    const [update, audit] = adapter.batches[0];
    expect(update.params).toEqual([
      'denied',
      'approval',
      'approver',
      'denied',
      'tenant-1',
      'elev-1',
      15,
    ]);
    expect(audit.sql).toContain(
      'FROM agent_elevation_challenges WHERE tenant_id = ? AND id = ? AND status = ? AND approver_id = ?'
    );
    expect(audit.params?.slice(-4)).toEqual(['tenant-1', 'elev-1', 'denied', 'approver']);
    adapter.batchRowsAffected.push([0, 1]);
    await expect(repository.decideElevation(decision)).resolves.toBe(false);
    adapter.batchRowsAffected.push([1, 0]);
    await expect(repository.decideElevation(decision)).resolves.toBe(false);
  });

  it('records reconciliation evidence only when both writes apply', async () => {
    const { adapter, repository } = mutRepo();
    const input = {
      tenantId: 'tenant-1',
      challengeId: 'elev-1',
      reconciledBy: 'admin-1',
      outcome: 'executed' as const,
      evidenceEnvelope: 'env',
      evidenceDigest: 'dig',
      reconciledAt: 70,
      audit: mutAudit('audit-rec'),
    };
    await expect(repository.reconcileIndeterminateElevation(input)).resolves.toBe(true);
    expect(adapter.batches[0][0].params).toEqual([
      'admin-1',
      'executed',
      'env',
      'dig',
      70,
      'tenant-1',
      'elev-1',
    ]);
    expect(adapter.batches[0][1].params?.slice(-4)).toEqual([
      'tenant-1',
      'elev-1',
      'admin-1',
      'executed',
    ]);
    adapter.batchRowsAffected.push([0, 1]);
    await expect(repository.reconcileIndeterminateElevation(input)).resolves.toBe(false);
    adapter.batchRowsAffected.push([1, 0]);
    await expect(repository.reconcileIndeterminateElevation(input)).resolves.toBe(false);
  });
});
