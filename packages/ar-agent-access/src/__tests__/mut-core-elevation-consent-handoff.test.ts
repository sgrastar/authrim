import { describe, expect, it, vi } from 'vitest';
import { sha256Base64Url } from '../core/canonical-json';
import { hasCurrentAgentConsent, type AgentConsentContract } from '../core/consent';
import { reconcileStaleAgentElevations } from '../core/elevation-reconciler';
import {
  ADMIN_AGENT_LOGIN_HANDOFF_ID_PATTERN,
  buildAdminAgentLoginHandoffConsumeUrl,
  hashAdminAgentLoginHandoffBrowserBinding,
  hashAdminAgentLoginHandoffCode,
  hashAdminAgentLoginHandoffSession,
} from '../core/login-handoff';

const stale = {
  id: 'challenge-1',
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  attempt: 2,
  fence: 4,
  ownerId: 'worker-1',
  leaseExpiresAt: 90,
  retryCount: 0,
};

function run(
  lookup: unknown,
  repoOverrides: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  const repository = {
    listStaleElevationExecutions: vi.fn().mockResolvedValue([stale]),
    reconcileStaleElevation: vi.fn().mockResolvedValue(true),
    deferStaleElevation: vi.fn().mockResolvedValue(true),
    ...repoOverrides,
  };
  const result = reconcileStaleAgentElevations({
    repository,
    idempotencyStatus: { lookup: vi.fn().mockResolvedValue(lookup) },
    reconcilerId: 'cron-1',
    createAuditId: () => 'audit-1',
    now: () => 100,
    ...extra,
  });
  return { repository, result };
}

const summary = (overrides: Record<string, number>) => ({
  inspected: 1,
  consumed: 0,
  failed: 0,
  indeterminate: 0,
  deferred: 0,
  lostRace: 0,
  ...overrides,
});

describe('reconcileStaleAgentElevations exact writes', () => {
  it('records a failed result with its envelope and an info audit', async () => {
    const { repository, result } = run({
      status: 'failed',
      operation: 'op',
      requestDigest: 'rd',
      resultEnvelope: 'env',
      resultDigest: 'dig',
    });
    await expect(result).resolves.toEqual(summary({ failed: 1 }));
    expect(repository.reconcileStaleElevation).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      challengeId: 'challenge-1',
      expectedAttempt: 2,
      expectedFence: 4,
      staleBefore: 100,
      status: 'failed',
      resultEnvelope: 'env',
      resultDigest: 'dig',
      reconciledAt: 100,
      audit: {
        id: 'audit-1',
        tenantId: 'tenant-1',
        action: 'agent.elevation.recovered',
        resourceType: 'agent_elevation_challenge',
        resourceId: 'challenge-1',
        severity: 'info',
        actorType: 'system',
        actorSub: 'system:cron-1',
        grantId: 'grant-1',
        elevationId: 'challenge-1',
        metadata: {
          idempotency_status: 'failed',
          execution_attempt: 2,
          execution_fence: 4,
          execution_lease_expires_at: 90,
          reconciler_id: 'cron-1',
        },
        createdAt: 100,
      },
    });
  });

  it('marks unknown outcomes indeterminate with a warning and no result envelope', async () => {
    const { repository, result } = run({ status: 'not_found' });
    await expect(result).resolves.toEqual(summary({ indeterminate: 1 }));
    const call = (repository.reconcileStaleElevation.mock.calls[0] as [{ audit: unknown }])[0];
    expect(call).not.toHaveProperty('resultEnvelope');
    expect(call.audit).toMatchObject({ severity: 'warn', action: 'agent.elevation.indeterminate' });
  });

  it('treats an expired in-progress lease as indeterminate rather than deferring', async () => {
    const { repository, result } = run({
      status: 'in_progress',
      operation: 'op',
      requestDigest: 'rd',
      leaseExpiresAt: 100,
    });
    await expect(result).resolves.toEqual(summary({ indeterminate: 1 }));
    expect(repository.deferStaleElevation).not.toHaveBeenCalled();
  });

  it('defers a live in-progress lease up to the maximum defer window', async () => {
    const { repository, result } = run(
      { status: 'in_progress', operation: 'op', requestDigest: 'rd', leaseExpiresAt: 10_000 },
      {},
      { maximumDeferMilliseconds: 500 }
    );
    await expect(result).resolves.toEqual(summary({ deferred: 1 }));
    expect(repository.deferStaleElevation).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      challengeId: 'challenge-1',
      expectedAttempt: 2,
      expectedFence: 4,
      staleBefore: 100,
      leaseExpiresAt: 600,
    });
  });

  it('counts a lost defer race', async () => {
    const { result } = run(
      { status: 'in_progress', operation: 'op', requestDigest: 'rd', leaseExpiresAt: 101 },
      { deferStaleElevation: vi.fn().mockResolvedValue(false) }
    );
    await expect(result).resolves.toEqual(summary({ lostRace: 1 }));
  });

  it('counts a lost reconcile race', async () => {
    const { result } = run(
      { status: 'succeeded', operation: 'op', requestDigest: 'rd' },
      { reconcileStaleElevation: vi.fn().mockResolvedValue(false) }
    );
    await expect(result).resolves.toEqual(summary({ lostRace: 1 }));
  });
});

const consent = (overrides: Partial<AgentConsentContract>): AgentConsentContract => ({
  id: 'c',
  tenantId: 't1',
  grantId: 'g1',
  userId: 'u1',
  clientId: 'client-1',
  type: 'delegation',
  consentVersion: 2,
  scopes: ['agent:read'],
  grantedAt: 1,
  ...overrides,
});

describe('hasCurrentAgentConsent', () => {
  const delegation = consent({ id: 'd' });
  const oauth = consent({ id: 'o', type: 'oauth_client', consentVersion: 1 });

  it('requires matching active delegation and OAuth client consents at the grant version', () => {
    expect(hasCurrentAgentConsent([delegation, oauth], 2)).toBe(true);
    expect(hasCurrentAgentConsent([oauth, delegation], 2)).toBe(true);
    expect(hasCurrentAgentConsent([delegation, oauth], 1)).toBe(false);
  });

  it.each([
    ['no consents', []],
    ['only delegation', [delegation]],
    ['only oauth', [oauth]],
    ['revoked delegation', [{ ...delegation, revokedAt: 5 }, oauth]],
    ['revoked oauth', [delegation, { ...oauth, revokedAt: 5 }]],
    ['tenant mismatch', [delegation, { ...oauth, tenantId: 't2' }]],
    ['grant mismatch', [delegation, { ...oauth, grantId: 'g2' }]],
    ['user mismatch', [delegation, { ...oauth, userId: 'u2' }]],
    ['client mismatch', [delegation, { ...oauth, clientId: 'client-2' }]],
  ])('denies with %s', (_label, consents) => {
    expect(hasCurrentAgentConsent(consents, 2)).toBe(false);
  });

  it('ignores revoked entries when an active replacement exists', () => {
    expect(
      hasCurrentAgentConsent(
        [{ ...delegation, revokedAt: 5, consentVersion: 1 }, oauth, delegation],
        2
      )
    ).toBe(true);
  });
});

describe('login handoff', () => {
  const code = 'ahc_' + 'a'.repeat(43);

  it('uses domain-separated hashes', async () => {
    await expect(hashAdminAgentLoginHandoffBrowserBinding('alh_1', 's')).resolves.toBe(
      await sha256Base64Url('authrim-admin-agent-handoff-browser-v1\0alh_1\0s')
    );
    await expect(hashAdminAgentLoginHandoffCode('c')).resolves.toBe(
      await sha256Base64Url('authrim-admin-agent-handoff-code-v1\0c')
    );
    await expect(hashAdminAgentLoginHandoffSession('s')).resolves.toBe(
      await sha256Base64Url('authrim-admin-agent-handoff-session-v1\0s')
    );
  });

  it('matches handoff IDs exactly', () => {
    expect(ADMIN_AGENT_LOGIN_HANDOFF_ID_PATTERN.test('alh_' + 'A_-9'.repeat(8))).toBe(true);
    for (const id of [
      'xalh_' + 'a'.repeat(32),
      'alh_' + 'a'.repeat(33),
      'alh_' + 'a'.repeat(31),
      'alh_' + '!'.repeat(32),
    ]) {
      expect(ADMIN_AGENT_LOGIN_HANDOFF_ID_PATTERN.test(id)).toBe(false);
    }
  });

  it('builds the consume URL for an exact HTTPS origin', () => {
    expect(buildAdminAgentLoginHandoffConsumeUrl('https://auth.example', code)).toBe(
      `https://auth.example/oauth/admin-agent/login-handoff/consume?code=${code}`
    );
  });

  it.each([['x' + code], [code + 'a'], ['ahc_short']])('rejects malformed code %s', (bad) => {
    expect(() => buildAdminAgentLoginHandoffConsumeUrl('https://auth.example', bad)).toThrow(
      'Invalid Admin Agent login handoff code'
    );
  });

  it.each([['http://auth.example'], ['https://auth.example/'], ['https://u@auth.example']])(
    'rejects target origin %s',
    (origin) => {
      expect(() => buildAdminAgentLoginHandoffConsumeUrl(origin, code)).toThrow(
        'Invalid Admin Agent login handoff target origin'
      );
    }
  );
});
