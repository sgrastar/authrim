import { describe, expect, it, vi } from 'vitest';
import { reconcileStaleAgentElevations } from '../elevation-reconciler';

function stale(id: string) {
  return {
    id,
    tenantId: 'tenant-1',
    grantId: 'grant-1',
    attempt: 2,
    fence: 4,
    ownerId: 'worker-1',
    leaseExpiresAt: 90,
    retryCount: 0,
  };
}

function repository(rows = [stale('challenge-1')]) {
  return {
    listStaleElevationExecutions: vi.fn().mockResolvedValue(rows),
    reconcileStaleElevation: vi.fn().mockResolvedValue(true),
    deferStaleElevation: vi.fn().mockResolvedValue(true),
  };
}

const baseOptions = {
  reconcilerId: 'cron-1',
  createAuditId: () => 'audit-1',
  now: () => 100,
};

describe('reconcileStaleAgentElevations', () => {
  it('records a durable succeeded result as consumed with a synchronous audit', async () => {
    const repo = repository();
    const result = await reconcileStaleAgentElevations({
      ...baseOptions,
      repository: repo,
      idempotencyStatus: {
        lookup: vi.fn().mockResolvedValue({
          status: 'succeeded',
          resultEnvelope: '{"ok":true}',
          resultDigest: 'digest-1',
        }),
      },
    });

    expect(result).toEqual({
      inspected: 1,
      consumed: 1,
      failed: 0,
      indeterminate: 0,
      deferred: 0,
      lostRace: 0,
    });
    expect(repo.reconcileStaleElevation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'consumed',
        resultDigest: 'digest-1',
        audit: expect.objectContaining({
          action: 'agent.elevation.recovered',
          elevationId: 'challenge-1',
        }),
      })
    );
  });

  it('never treats a missing target record as proof that execution did not happen', async () => {
    const repo = repository();
    const result = await reconcileStaleAgentElevations({
      ...baseOptions,
      repository: repo,
      idempotencyStatus: {
        lookup: vi.fn().mockResolvedValue({ status: 'not_found' }),
      },
    });

    expect(result.indeterminate).toBe(1);
    expect(repo.reconcileStaleElevation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'indeterminate',
        audit: expect.objectContaining({ action: 'agent.elevation.indeterminate' }),
      })
    );
    expect(repo.deferStaleElevation).not.toHaveBeenCalled();
  });

  it('defers only to a bounded future target lease', async () => {
    const repo = repository();
    const result = await reconcileStaleAgentElevations({
      ...baseOptions,
      maximumDeferMilliseconds: 30,
      repository: repo,
      idempotencyStatus: {
        lookup: vi.fn().mockResolvedValue({ status: 'in_progress', leaseExpiresAt: 1000 }),
      },
    });

    expect(result.deferred).toBe(1);
    expect(repo.deferStaleElevation).toHaveBeenCalledWith(
      expect.objectContaining({ leaseExpiresAt: 130 })
    );
    expect(repo.reconcileStaleElevation).not.toHaveBeenCalled();
  });

  it('marks an already stale target lease indeterminate instead of retrying', async () => {
    const repo = repository();
    const result = await reconcileStaleAgentElevations({
      ...baseOptions,
      repository: repo,
      idempotencyStatus: {
        lookup: vi.fn().mockResolvedValue({ status: 'in_progress', leaseExpiresAt: 99 }),
      },
    });

    expect(result.indeterminate).toBe(1);
    expect(repo.reconcileStaleElevation).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'indeterminate' })
    );
  });

  it('reports a CAS loss without overwriting the newer execution owner', async () => {
    const repo = repository();
    repo.reconcileStaleElevation.mockResolvedValue(false);
    const result = await reconcileStaleAgentElevations({
      ...baseOptions,
      repository: repo,
      idempotencyStatus: {
        lookup: vi.fn().mockResolvedValue({ status: 'failed' }),
      },
    });

    expect(result.lostRace).toBe(1);
    expect(result.failed).toBe(0);
  });
});
