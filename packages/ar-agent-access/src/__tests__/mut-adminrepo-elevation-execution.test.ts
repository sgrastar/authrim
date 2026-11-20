import { describe, expect, it } from 'vitest';
import { AgentAccessConflictError } from '../core/repositories';
import { mutAudit, mutRepo } from './helpers/mut-adminrepo-adapter';

const elevationRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'elev-1',
  tenant_id: 'tenant-1',
  grant_id: 'grant-1',
  status: 'executing',
  execution_attempt: 2,
  execution_fence: 5,
  execution_owner_id: 'owner-1',
  execution_lease_expires_at: 90,
  retry_count: 1,
  ...overrides,
});
const noRows = { rowsAffected: 0, success: true };

describe('claimElevationExecution', () => {
  it('returns the claimed attempt and fence from the re-read row', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(elevationRow());
    await expect(
      repository.claimElevationExecution('tenant-1', 'elev-1', 'owner-1', 10, 80)
    ).resolves.toEqual({
      id: 'elev-1',
      attempt: 2,
      fence: 5,
      ownerId: 'owner-1',
      leaseExpiresAt: 90,
    });
    expect(adapter.calls[0].params).toEqual([10, 'owner-1', 80, 'tenant-1', 'elev-1', 10]);
    expect(adapter.calls[1].params).toEqual(['tenant-1', 'elev-1']);
    expect(adapter.calls[1].sql).toContain(
      'FROM agent_elevation_challenges WHERE tenant_id = ? AND id = ?'
    );
  });

  it('falls back to the requested lease when the row has none', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(elevationRow({ execution_lease_expires_at: null }));
    await expect(
      repository.claimElevationExecution('tenant-1', 'elev-1', 'owner-1', 10, 80)
    ).resolves.toMatchObject({ leaseExpiresAt: 80 });
  });

  it('returns null without re-reading when the claim CAS loses', async () => {
    const { adapter, repository } = mutRepo();
    adapter.executeResults.push(noRows);
    await expect(
      repository.claimElevationExecution('tenant-1', 'elev-1', 'owner-1', 10, 80)
    ).resolves.toBeNull();
    expect(adapter.calls).toHaveLength(1);
  });

  it.each([
    ['missing', null],
    ['not executing', elevationRow({ status: 'approved' })],
    ['owned by someone else', elevationRow({ execution_owner_id: 'owner-2' })],
  ])('returns null when the re-read row is %s', async (_name, row) => {
    const { adapter, repository } = mutRepo();
    if (row) adapter.queryOneResults.push(row);
    await expect(
      repository.claimElevationExecution('tenant-1', 'elev-1', 'owner-1', 10, 80)
    ).resolves.toBeNull();
  });
});

describe('completeElevationExecution', () => {
  const input = {
    tenantId: 'tenant-1',
    challengeId: 'elev-1',
    ownerId: 'owner-1',
    attempt: 2,
    fence: 5,
    status: 'consumed' as const,
    completedAt: 40,
  };

  it('binds the result and fence and reports the CAS outcome', async () => {
    const { adapter, repository } = mutRepo();
    await expect(
      repository.completeElevationExecution({
        ...input,
        resultEnvelope: 'env',
        resultDigest: 'dig',
      })
    ).resolves.toBe(true);
    expect(adapter.calls[0].sql).toContain(
      "consumed_at = CASE WHEN ? = 'consumed' THEN ? ELSE NULL END"
    );
    expect(adapter.calls[0].params).toEqual([
      'consumed',
      'env',
      'dig',
      'consumed',
      40,
      40,
      'tenant-1',
      'elev-1',
      'owner-1',
      2,
      5,
    ]);
    adapter.executeResults.push(noRows);
    await expect(repository.completeElevationExecution(input)).resolves.toBe(false);
    expect(adapter.calls[1].params?.slice(1, 3)).toEqual([null, null]);
  });
});

describe('listStaleElevationExecutions', () => {
  it('maps stale rows, drops rows without a lease and clamps the limit', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryResults.push([
      elevationRow({ execution_owner_id: null, retry_count: 0 }),
      elevationRow({ id: 'elev-2', execution_lease_expires_at: null }),
    ]);
    await expect(repository.listStaleElevationExecutions(100, 500)).resolves.toEqual([
      {
        id: 'elev-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        attempt: 2,
        fence: 5,
        ownerId: null,
        leaseExpiresAt: 90,
        retryCount: 0,
      },
    ]);
    expect(adapter.calls[0].sql).toContain(
      "WHERE status = 'executing' AND execution_lease_expires_at < ?"
    );
    expect(adapter.calls[0].params).toEqual([100, 100]);
    await repository.listStaleElevationExecutions(100, 0);
    expect(adapter.calls[1].params).toEqual([100, 1]);
    await repository.listStaleElevationExecutions(100, 7.9);
    expect(adapter.calls[2].params).toEqual([100, 7]);
    await repository.listStaleElevationExecutions(100);
    expect(adapter.calls[3].params).toEqual([100, 100]);
  });

  it('purges expired payloads and returns the count', async () => {
    const { adapter, repository } = mutRepo();
    adapter.executeResults.push({ rowsAffected: 3, success: true });
    await expect(repository.purgeExpiredElevationPayloads(70)).resolves.toBe(3);
    expect(adapter.calls[0].params).toEqual([70, 70]);
  });
});

describe('reconcileStaleElevation', () => {
  const input = (audit = mutAudit('audit-st', { elevationId: 'elev-1', grantId: 'grant-1' })) => ({
    tenantId: 'tenant-1',
    challengeId: 'elev-1',
    expectedAttempt: 2,
    expectedFence: 5,
    staleBefore: 60,
    status: 'failed' as const,
    reconciledAt: 61,
    audit,
  });

  it.each([
    [
      'another tenant',
      mutAudit('a', { tenantId: 'tenant-2', elevationId: 'elev-1', grantId: 'g' }),
    ],
    ['another elevation', mutAudit('a', { elevationId: 'elev-2', grantId: 'g' })],
    ['no Grant', mutAudit('a', { elevationId: 'elev-1' })],
  ])('rejects an audit with %s', async (_name, audit) => {
    const { adapter, repository } = mutRepo();
    await expect(repository.reconcileStaleElevation(input(audit))).rejects.toThrow(
      new TypeError('Elevation reconciliation audit does not match the recovered row')
    );
    expect(adapter.batches).toHaveLength(0);
  });

  it('returns true on a won CAS and checks the replay otherwise', async () => {
    const { adapter, repository } = mutRepo();
    await expect(repository.reconcileStaleElevation(input())).resolves.toBe(true);
    expect(adapter.batches[0][0].params).toEqual([
      'failed',
      null,
      null,
      'failed',
      61,
      61,
      'audit-st',
      'tenant-1',
      'elev-1',
      60,
      2,
      5,
    ]);
    expect(adapter.calls).toHaveLength(0);
    adapter.batchRowsAffected.push([0]);
    await expect(repository.reconcileStaleElevation(input())).resolves.toBe(false);
    expect(adapter.calls[0].params).toEqual(['tenant-1', 'elev-1', 'failed', 'audit-st']);
    adapter.batchRowsAffected.push([0]);
    adapter.queryOneResults.push({ terminal_transition_id: 'audit-st' });
    await expect(repository.reconcileStaleElevation(input())).resolves.toBe(true);
  });
});

describe('deferStaleElevation and claimStaleElevationRetry', () => {
  it('defers only the observed stale attempt', async () => {
    const { adapter, repository } = mutRepo();
    const input = {
      tenantId: 'tenant-1',
      challengeId: 'elev-1',
      expectedAttempt: 2,
      expectedFence: 5,
      staleBefore: 60,
      leaseExpiresAt: 120,
    };
    await expect(repository.deferStaleElevation(input)).resolves.toBe(true);
    expect(adapter.calls[0].sql).toContain('SET execution_lease_expires_at = ?');
    expect(adapter.calls[0].params).toEqual([120, 'tenant-1', 'elev-1', 60, 2, 5]);
    adapter.executeResults.push(noRows);
    await expect(repository.deferStaleElevation(input)).resolves.toBe(false);
  });

  const retry = {
    tenantId: 'tenant-1',
    challengeId: 'elev-1',
    expectedAttempt: 1,
    expectedFence: 4,
    staleBefore: 60,
    now: 61,
    ownerId: 'owner-1',
    leaseExpiresAt: 120,
  };

  it('returns the verified retry claim', async () => {
    const { adapter, repository } = mutRepo();
    adapter.queryOneResults.push(elevationRow({ execution_lease_expires_at: null }));
    await expect(repository.claimStaleElevationRetry(retry)).resolves.toEqual({
      id: 'elev-1',
      attempt: 2,
      fence: 5,
      ownerId: 'owner-1',
      leaseExpiresAt: 120,
    });
    expect(adapter.calls[0].sql).toContain('AND retry_count = 0');
    expect(adapter.calls[0].params).toEqual(['owner-1', 120, 61, 'tenant-1', 'elev-1', 60, 1, 4]);
    expect(adapter.calls[1].params).toEqual(['tenant-1', 'elev-1']);
  });

  it('returns null when the retry CAS loses', async () => {
    const { adapter, repository } = mutRepo();
    adapter.executeResults.push(noRows);
    await expect(repository.claimStaleElevationRetry(retry)).resolves.toBeNull();
    expect(adapter.calls).toHaveLength(1);
  });

  it.each([
    ['missing', null],
    ['not executing', elevationRow({ status: 'failed' })],
    ['owned by another worker', elevationRow({ execution_owner_id: 'owner-2' })],
    ['retried more than once', elevationRow({ retry_count: 2 })],
  ])('fails closed when the claimed row is %s', async (_name, row) => {
    const { adapter, repository } = mutRepo();
    if (row) adapter.queryOneResults.push(row);
    await expect(repository.claimStaleElevationRetry(retry)).rejects.toThrow(
      new AgentAccessConflictError('Elevation retry claim could not be verified')
    );
  });
});
