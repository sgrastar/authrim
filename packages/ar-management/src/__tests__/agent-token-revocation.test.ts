import { describe, expect, it, vi } from 'vitest';
import { processAgentTokenRevocationOutbox } from '../agent-token-revocation';

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'outbox-1',
    tenantId: 'tenant-1',
    grantId: 'grant-1',
    grantGeneration: 2,
    clientId: 'client-1',
    eventType: 'revoke_grant_families' as const,
    familyIds: ['family-1'],
    familyJtis: ['rtv3_0_locator-jti'],
    reason: 'grant_revoked',
    attempt: 1,
    fence: 3,
    ownerId: 'owner-1',
    leaseExpiresAt: 160_000,
    ...overrides,
  };
}

function repository(claimed = claim()) {
  return {
    listClaimableTokenRevocations: vi.fn().mockResolvedValue(['outbox-1']),
    claimTokenRevocationOutbox: vi.fn().mockResolvedValue(claimed),
    completeTokenRevocationOutbox: vi.fn().mockResolvedValue(true),
    failTokenRevocationOutbox: vi.fn().mockResolvedValue('retry_scheduled'),
  };
}

describe('Agent refresh family revocation outbox', () => {
  it('uses the JTI only as a shard locator and revokes the immutable family ID', async () => {
    const repo = repository();
    const revoke = vi.fn().mockResolvedValue(undefined);
    const summary = await processAgentTokenRevocationOutbox(
      repo,
      { revoke },
      {
        now: () => 100_000,
        createId: () => 'owner-1',
      }
    );

    expect(revoke).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      familyId: 'family-1',
      familyJti: 'rtv3_0_locator-jti',
      reason: 'grant_revoked',
    });
    expect(repo.completeTokenRevocationOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        familyIds: ['family-1'],
        fence: 3,
        completionId: 'owner-1',
      })
    );
    expect(summary.completed).toBe(1);
  });

  it('schedules a fenced retry after a partial DO failure', async () => {
    const repo = repository(
      claim({
        familyIds: ['family-1', 'family-2'],
        familyJtis: ['rtv3_0_jti-1', 'rtv3_0_jti-2'],
        attempt: 2,
      })
    );
    const revoke = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('DO unavailable'));
    const summary = await processAgentTokenRevocationOutbox(
      repo,
      { revoke },
      {
        now: () => 100_000,
        createId: (prefix) => `${prefix}-1`,
      }
    );

    expect(repo.completeTokenRevocationOutbox).not.toHaveBeenCalled();
    expect(repo.failTokenRevocationOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxId: 'outbox-1',
        fence: 3,
        expectedAttempt: 2,
        nextAttemptAt: 102_000,
        deadLetterAudit: expect.objectContaining({ actorType: 'system' }),
      })
    );
    expect(summary.retryScheduled).toBe(1);
  });
});
