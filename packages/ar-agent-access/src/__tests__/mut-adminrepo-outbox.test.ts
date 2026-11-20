import { describe, expect, it } from 'vitest';
import { mutAudit, mutRepo } from './helpers/mut-adminrepo-adapter';

const noRows = { rowsAffected: 0, success: true };
const outboxRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'outbox-1',
  tenant_id: 'tenant-1',
  grant_id: 'grant-1',
  grant_generation: 3,
  client_id: 'client-1',
  event_type: 'revoke_grant_families',
  payload: JSON.stringify({ family_ids: ['f1'], family_jtis: ['j1'], reason: 'admin' }),
  status: 'processing',
  attempt_count: 2,
  processing_fence: 4,
  processing_owner_id: 'owner-1',
  processing_lease_expires_at: 90,
  ...overrides,
});

describe('createTokenRevocationOutbox', () => {
  const input = {
    id: 'outbox-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    eventType: 'revoke_client_families' as const,
    familyIds: ['f1'],
    familyJtis: ['j1'],
    reason: 'client_metadata_changed',
    nextAttemptAt: 10,
    createdAt: 5,
  };

  it('stores a pending client-wide outbox row with a canonical payload', async () => {
    const { adapter, repository } = mutRepo();
    await repository.createTokenRevocationOutbox(input);
    expect(adapter.calls[0].sql).toContain("'pending', 0, 0, ?, ?)");
    expect(adapter.calls[0].params).toEqual([
      'outbox-1',
      'tenant-1',
      null,
      null,
      'client-1',
      'revoke_client_families',
      '{"family_ids":["f1"],"family_jtis":["j1"],"reason":"client_metadata_changed"}',
      10,
      5,
    ]);
    await repository.createTokenRevocationOutbox({
      ...input,
      grantId: 'grant-1',
      grantGeneration: 3,
    });
    expect(adapter.calls[1].params?.slice(2, 4)).toEqual(['grant-1', 3]);
  });

  it('rejects mismatched family ID and JTI counts', async () => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.createTokenRevocationOutbox({ ...input, familyJtis: [] })
    ).rejects.toThrow(new TypeError('Agent token revocation family ID/JTI counts must match'));
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('listClaimableTokenRevocations and claimTokenRevocationOutbox', () => {
  it('lists claimable IDs with a clamped limit', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryResults.push([{ id: 'a' }, { id: 'b' }]);
    await expect(repository.listClaimableTokenRevocations(50, 1000)).resolves.toEqual(['a', 'b']);
    expect(adapter.calls[0].sql).toContain(
      "OR (status = 'processing' AND processing_lease_expires_at < ?)"
    );
    expect(adapter.calls[0].params).toEqual([50, 50, 100]);
    await repository.listClaimableTokenRevocations(50, -4);
    expect(adapter.calls[1].params).toEqual([50, 50, 1]);
    await repository.listClaimableTokenRevocations(50);
    expect(adapter.calls[2].params).toEqual([50, 50, 100]);
  });

  const claim = { outboxId: 'outbox-1', ownerId: 'owner-1', now: 20, leaseExpiresAt: 90 };

  it('returns the claimed row with its parsed payload', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(outboxRow());
    await expect(repository.claimTokenRevocationOutbox(claim)).resolves.toEqual({
      id: 'outbox-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 3,
      clientId: 'client-1',
      eventType: 'revoke_grant_families',
      familyIds: ['f1'],
      familyJtis: ['j1'],
      reason: 'admin',
      attempt: 2,
      fence: 4,
      ownerId: 'owner-1',
      leaseExpiresAt: 90,
    });
    expect(adapter.calls[0].params).toEqual(['owner-1', 90, 'outbox-1', 20, 20]);
    expect(adapter.calls[1].params).toEqual(['outbox-1']);
  });

  it('maps a client-wide row without Grant fields', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(outboxRow({ grant_id: null, grant_generation: null }));
    const claimed = await repository.claimTokenRevocationOutbox(claim);
    expect(claimed?.grantId).toBeUndefined();
    expect(claimed?.grantGeneration).toBeUndefined();
  });

  it('returns null without re-reading when the claim CAS loses', async () => {
    const { adapter, repository } = mutRepo();
    adapter.executeResults.push(noRows);
    await expect(repository.claimTokenRevocationOutbox(claim)).resolves.toBeNull();
    expect(adapter.calls).toHaveLength(1);
  });

  it.each([
    ['missing', null],
    ['not processing', outboxRow({ status: 'pending' })],
    ['owned by another worker', outboxRow({ processing_owner_id: 'owner-2' })],
    ['without a lease', outboxRow({ processing_lease_expires_at: null })],
  ])('returns null when the re-read row is %s', async (_name, row) => {
    const { adapter, repository } = mutRepo();
    if (row) adapter.queryOneResults.push(row);
    await expect(repository.claimTokenRevocationOutbox(claim)).resolves.toBeNull();
  });
});

describe('completeTokenRevocationOutbox', () => {
  const input = {
    outboxId: 'outbox-1',
    tenantId: 'tenant-1',
    ownerId: 'owner-1',
    fence: 4,
    completionId: 'done-1',
    familyIds: ['f1', 'f2'],
    completedAt: 60,
  };

  it('completes the fenced row and revokes each family in one batch', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.completeTokenRevocationOutbox(input)).resolves.toBe(true);
    const batch = adapter.batches[0];
    expect(batch).toHaveLength(3);
    expect(batch[0].params).toEqual([60, 'done-1', 'outbox-1', 'tenant-1', 'owner-1', 4]);
    expect(batch[2].params).toEqual([60, 'f2', 'tenant-1', 'outbox-1', 'tenant-1', 'done-1']);
    expect(adapter.calls).toHaveLength(0);
  });

  it('accepts only the same completion on replay', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0], [0]);
    await expect(repository.completeTokenRevocationOutbox(input)).resolves.toBe(false);
    expect(adapter.calls[0].params).toEqual(['outbox-1', 'tenant-1', 'done-1']);
    adapter.queryOneResults.push({ completion_transition_id: 'done-1' });
    await expect(repository.completeTokenRevocationOutbox(input)).resolves.toBe(true);
  });
});

describe('failTokenRevocationOutbox', () => {
  const base = {
    outboxId: 'outbox-1',
    tenantId: 'tenant-1',
    ownerId: 'owner-1',
    fence: 4,
    expectedAttempt: 2,
    nextAttemptAt: 80,
    deadLetterAudit: mutAudit('fail-1', {
      resourceId: 'outbox-1',
      actorType: 'system',
      actorSub: 'system:x',
    }),
  };

  it('schedules a retry below the attempt ceiling', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.failTokenRevocationOutbox(base)).resolves.toBe('retry_scheduled');
    expect(adapter.batches[0][0].params).toEqual([
      'pending',
      80,
      'fail-1',
      'outbox-1',
      'tenant-1',
      'owner-1',
      4,
      2,
    ]);
  });

  it('dead-letters at the default ceiling of eight attempts', async () => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.failTokenRevocationOutbox({ ...base, expectedAttempt: 7 })
    ).resolves.toBe('retry_scheduled');
    await expect(
      repository.failTokenRevocationOutbox({ ...base, expectedAttempt: 8 })
    ).resolves.toBe('dead_letter');
    expect(adapter.batches[1][0].params?.[0]).toBe('dead_letter');
  });

  it('honours a custom ceiling, truncating and flooring it at one', async () => {
    const { repository } = mutRepo();
    await expect(repository.failTokenRevocationOutbox({ ...base, maxAttempts: 2.9 })).resolves.toBe(
      'dead_letter'
    );
    await expect(
      repository.failTokenRevocationOutbox({ ...base, expectedAttempt: 1, maxAttempts: 0 })
    ).resolves.toBe('dead_letter');
    await expect(repository.failTokenRevocationOutbox({ ...base, maxAttempts: 3 })).resolves.toBe(
      'retry_scheduled'
    );
  });

  it.each([
    [
      'tenant',
      mutAudit('fail-1', { tenantId: 'tenant-2', resourceId: 'outbox-1', actorType: 'system' }),
    ],
    ['resource', mutAudit('fail-1', { resourceId: 'outbox-2', actorType: 'system' })],
    ['actor type', mutAudit('fail-1', { resourceId: 'outbox-1', actorType: 'admin_user' })],
  ])('rejects a dead-letter audit with another %s', async (_name, deadLetterAudit) => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.failTokenRevocationOutbox({ ...base, expectedAttempt: 8, deadLetterAudit })
    ).rejects.toThrow(
      new TypeError('Token revocation dead-letter audit does not match the outbox row')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('does not validate the dead-letter audit for a retry', async () => {
    const { repository } = mutRepo();
    await expect(
      repository.failTokenRevocationOutbox({
        ...base,
        deadLetterAudit: mutAudit('fail-1', { actorType: 'admin_user' }),
      })
    ).resolves.toBe('retry_scheduled');
  });

  it('resolves a lost CAS from the replay row only for the same failure transition', async () => {
    const { adapter, repository } = mutRepo();
    adapter.batchRowsAffected.push([0], [0], [0], [0]);
    await expect(repository.failTokenRevocationOutbox(base)).resolves.toBeNull();
    expect(adapter.calls[0].params).toEqual(['outbox-1', 'tenant-1', 'fail-1']);
    adapter.queryOneResults.push({ status: 'dead_letter', failure_transition_id: 'fail-1' });
    await expect(repository.failTokenRevocationOutbox(base)).resolves.toBe('dead_letter');
    adapter.queryOneResults.push({ status: 'pending', failure_transition_id: 'fail-1' });
    await expect(repository.failTokenRevocationOutbox(base)).resolves.toBe('retry_scheduled');
    adapter.queryOneResults.push({ status: 'pending', failure_transition_id: 'fail-9' });
    await expect(repository.failTokenRevocationOutbox(base)).resolves.toBeNull();
  });
});

describe('suspendForClientMetadataChange', () => {
  const input = {
    tenantId: 'tenant-1',
    clientId: 'client-1',
    oldHash: 'old',
    newHash: 'new',
    transitionId: 'transition-1',
    outboxId: 'outbox-1',
    now: 300,
  };

  it('does nothing when the client has no active Grant', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.suspendForClientMetadataChange(input)).resolves.toEqual({
      suspendedGrantCount: 0,
    });
    adapter.queryOneResults.push({ total: 0 });
    await expect(repository.suspendForClientMetadataChange(input)).resolves.toEqual({
      suspendedGrantCount: 0,
    });
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'client-1']);
    expect(adapter.calls[0].sql).toContain(
      "WHERE tenant_id = ? AND client_id = ? AND status = 'active'"
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('suspends, revokes consent, queues families and audits the change', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ total: 2 });
    await expect(repository.suspendForClientMetadataChange(input)).resolves.toEqual({
      suspendedGrantCount: 2,
    });
    const [grants, consents, families, outbox, audit] = adapter.batches[0];
    expect(adapter.batches[0]).toHaveLength(5);
    expect(grants.sql).toContain("SET status = 'suspended', active_uniqueness_key = id");
    expect(grants.params).toEqual([300, 'transition-1', 'tenant-1', 'client-1']);
    expect(consents.sql).toContain("revoked_reason = 'grant_updated'");
    expect(consents.params).toEqual([
      300,
      'transition-1',
      'tenant-1',
      'client-1',
      'tenant-1',
      'client-1',
      'transition-1',
    ]);
    expect(families.sql).toContain("SET status = 'revocation_pending'");
    expect(families.params).toEqual([
      300,
      'outbox-1',
      'tenant-1',
      'client-1',
      'tenant-1',
      'client-1',
      'transition-1',
    ]);
    expect(outbox.sql).toContain("'revoke_client_families'");
    expect(outbox.sql).toContain("'reason', 'client_metadata_changed'");
    expect(outbox.params).toEqual([
      'outbox-1',
      'tenant-1',
      'client-1',
      'tenant-1',
      'outbox-1',
      'tenant-1',
      'outbox-1',
      300,
      300,
      'tenant-1',
      'client-1',
      'transition-1',
    ]);
    expect(audit.sql).toContain(
      'FROM admin_agent_grants WHERE tenant_id = ? AND client_id = ? AND last_mutation_id = ?'
    );
    expect(audit.params?.slice(0, 13)).toEqual([
      'transition-1',
      'tenant-1',
      null,
      'agent.client_metadata.changed',
      'oauth_client',
      'client-1',
      'success',
      'warn',
      null,
      JSON.stringify({
        client_id: 'client-1',
        old_hash: 'old',
        new_hash: 'new',
        suspended_grant_count: 2,
      }),
      300,
      'system',
      'system:cimd-verifier',
    ]);
    expect(audit.params?.slice(-3)).toEqual(['tenant-1', 'client-1', 'transition-1']);
  });
});
