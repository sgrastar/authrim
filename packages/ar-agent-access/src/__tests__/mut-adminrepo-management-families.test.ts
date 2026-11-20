import { describe, expect, it } from 'vitest';
import { mutRepo } from './helpers/mut-adminrepo-adapter';

const noRows = { rowsAffected: 0, success: true };
const lookup = {
  tenantId: 'tenant-1',
  idempotencyKey: 'idem-1',
  executionAttempt: 2,
  executionFence: 3,
};

describe('Management execution fences', () => {
  it('begins an exact fence once and reports a duplicate as false', async () => {
    const { adapter, repository } = mutRepo();
    const input = {
      ...lookup,
      operation: 'users.delete',
      requestDigest: 'rd',
      leaseExpiresAt: 90,
      createdAt: 10,
    };
    await expect(repository.beginManagementExecution(input)).resolves.toBe(true);
    expect(adapter.calls[0].sql).toContain("VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)");
    expect(adapter.calls[0].params).toEqual([
      'tenant-1',
      'idem-1',
      2,
      3,
      'users.delete',
      'rd',
      90,
      10,
      10,
    ]);
    adapter.executeResults.push(noRows);
    await expect(repository.beginManagementExecution(input)).resolves.toBe(false);
  });

  it('completes only the active attempt and binds an optional envelope', async () => {
    const { adapter, repository } = mutRepo();
    const input = { ...lookup, status: 'succeeded' as const, resultDigest: 'dg', completedAt: 50 };
    await expect(
      repository.completeManagementExecution({ ...input, resultEnvelope: 'env' })
    ).resolves.toBe(true);
    expect(adapter.calls[0].params).toEqual([
      'succeeded',
      'env',
      'dg',
      50,
      'tenant-1',
      'idem-1',
      2,
      3,
    ]);
    adapter.executeResults.push(noRows);
    await expect(repository.completeManagementExecution(input)).resolves.toBe(false);
    expect(adapter.calls[1].params?.[1]).toBeNull();
  });

  it('reports a missing fence as not found', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.lookupManagementExecution(lookup)).resolves.toEqual({
      status: 'not_found',
    });
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'idem-1', 2, 3]);
    expect(adapter.calls[0].sql).toContain('FROM agent_management_executions');
  });

  it('reports an in-progress fence with its lease', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({
      operation: 'op',
      request_digest: 'rd',
      status: 'in_progress',
      lease_expires_at: 90,
      result_envelope: 'ignored',
      result_digest: 'ignored',
    });
    await expect(repository.lookupManagementExecution(lookup)).resolves.toStrictEqual({
      status: 'in_progress',
      operation: 'op',
      requestDigest: 'rd',
      leaseExpiresAt: 90,
    });
  });

  it('reports terminal fences with and without stored results', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(
      {
        operation: 'op',
        request_digest: 'rd',
        status: 'succeeded',
        lease_expires_at: 90,
        result_envelope: 'env',
        result_digest: 'dg',
      },
      {
        operation: 'op',
        request_digest: 'rd',
        status: 'failed',
        lease_expires_at: 90,
        result_envelope: null,
        result_digest: null,
      }
    );
    await expect(repository.lookupManagementExecution(lookup)).resolves.toStrictEqual({
      status: 'succeeded',
      operation: 'op',
      requestDigest: 'rd',
      resultEnvelope: 'env',
      resultDigest: 'dg',
    });
    await expect(repository.lookupManagementExecution(lookup)).resolves.toStrictEqual({
      status: 'failed',
      operation: 'op',
      requestDigest: 'rd',
    });
  });
});

describe('token families', () => {
  const family = {
    familyId: 'fam-1',
    familyJti: 'jti-1',
    tenantId: 'tenant-1',
    grantId: 'grant-1',
    grantGeneration: 3,
    adminUserId: 'admin-1',
    clientId: 'client-1',
    consentVersion: 2,
    finalizationNonce: 'nonce',
    expiresAt: 200,
    createdAt: 100,
  };

  it('creates a pending family', async () => {
    const { adapter, repository } = mutRepo();
    await repository.createPendingTokenFamily(family);
    expect(adapter.calls[0].sql).toContain("'pending_finalization', ?, ?, ?, ?)");
    expect(adapter.calls[0].params).toEqual([
      'fam-1',
      'jti-1',
      'tenant-1',
      'grant-1',
      3,
      'admin-1',
      'client-1',
      2,
      'nonce',
      200,
      100,
      100,
    ]);
  });

  it('rejects a family that expires at creation', async () => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.createPendingTokenFamily({ ...family, expiresAt: 100 })
    ).rejects.toThrow(new TypeError('Agent token family expiry must be after creation'));
    expect(adapter.calls).toHaveLength(0);
  });

  const jti = {
    jti: 'j',
    tenantId: 'tenant-1',
    grantId: 'grant-1',
    machinePrincipalId: 'mp',
    expiresAt: 50,
    consumedAt: 40,
  };

  it('consumes a live Mode B delegation JTI once', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.consumeModeBDelegationJti(jti)).resolves.toBe(true);
    expect(adapter.calls[0].params).toEqual(['j', 'tenant-1', 'grant-1', 'mp', 50, 40]);
    adapter.executeResults.push(noRows);
    await expect(repository.consumeModeBDelegationJti(jti)).resolves.toBe(false);
  });

  it('refuses an expired Mode B delegation JTI without writing', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.consumeModeBDelegationJti({ ...jti, expiresAt: 40 })).resolves.toBe(
      false
    );
    expect(adapter.calls).toHaveLength(0);
  });

  const usable = {
    familyId: 'fam-1',
    tenantId: 'tenant-1',
    grantId: 'grant-1',
    grantGeneration: 3,
    adminUserId: 'admin-1',
    clientId: 'client-1',
    consentVersion: 2,
    now: 150,
  };

  it('treats a family as usable only when the fenced join returns a row', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push({ usable: 1 });
    await expect(repository.isTokenFamilyUsable(usable)).resolves.toBe(true);
    expect(adapter.calls[0].sql).toContain("AND f.status = 'active' AND f.expires_at > ?");
    expect(adapter.calls[0].params).toEqual([
      'fam-1',
      'tenant-1',
      'grant-1',
      3,
      'admin-1',
      'client-1',
      2,
      150,
      150,
    ]);
    await expect(repository.isTokenFamilyUsable(usable)).resolves.toBe(false);
    adapter.queryOneResults.push({ usable: 0 });
    await expect(repository.isTokenFamilyUsable(usable)).resolves.toBe(false);
  });

  it('finalizes a family through the Grant and consent fences', async () => {
    const { adapter, repository } = mutRepo();
    const input = { ...usable, finalizationNonce: 'nonce' };
    await expect(repository.finalizeTokenFamily(input)).resolves.toBe(true);
    expect(adapter.calls[0].params).toEqual([
      150,
      150,
      'fam-1',
      'nonce',
      'tenant-1',
      'grant-1',
      3,
      'admin-1',
      'client-1',
      2,
      150,
      150,
    ]);
    adapter.executeResults.push(noRows);
    await expect(repository.finalizeTokenFamily(input)).resolves.toBe(false);
  });
});
