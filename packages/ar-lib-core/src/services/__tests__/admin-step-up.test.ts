import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Challenge, StoreChallengeRequest } from '../../durable-objects/ChallengeStore';
import type { AdminAuthContext } from '../../types/admin';
import type { Env } from '../../types/env';

// One in-memory ChallengeStore with the Durable Object's checks: type, tenant, single consume.
const challenges = vi.hoisted(() => new Map<string, Challenge>());

vi.mock('../../utils/challenge-sharding', () => ({
  getChallengeStoreByChallengeId: vi.fn(async () => ({
    storeChallengeRpc: async (request: StoreChallengeRequest) => {
      const now = Date.now();
      challenges.set(request.id, {
        id: request.id,
        tenantId: request.tenantId,
        type: request.type,
        userId: request.userId,
        challenge: request.challenge,
        metadata: request.metadata,
        createdAt: now,
        expiresAt: Math.min(now + request.ttl * 1000, request.notAfterMs ?? Infinity),
        consumed: false,
      });
      return { success: true };
    },
    getChallengeRpc: async (id: string) => challenges.get(id) ?? null,
    consumeChallengeRpc: async (request: { id: string; tenantId: string; type: string }) => {
      const challenge = challenges.get(request.id);
      if (
        !challenge ||
        challenge.type !== request.type ||
        challenge.tenantId !== request.tenantId ||
        challenge.consumed ||
        challenge.expiresAt <= Date.now()
      ) {
        throw new Error('Challenge not found or already consumed');
      }
      challenge.consumed = true;
      return {
        challenge: challenge.challenge,
        userId: challenge.userId,
        metadata: challenge.metadata,
      };
    },
  })),
}));

import {
  ADMIN_STEP_UP_EVIDENCE_WINDOW_MS,
  ADMIN_STEP_UP_RECEIPT_TTL_SECONDS,
  AdminStepUpError,
  adminStepUpOverridesProblem,
  consumeAdminStepUpReceipt,
  createAdminStepUpOperationHash,
  createAdminStepUpRequirement,
  describeAdminStepUpFreshness,
  evaluateAdminStepUpEvidence,
  issueAdminStepUpReceipt,
  resolveAdminStepUpLevel,
  type AdminStepUpBinding,
} from '../admin-step-up';

const env = {} as Env;

function human(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'admin-1',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    tenantId: 'tenant-a',
    sessionTenantId: 'default',
    sessionId: 'sess-1',
    mfaVerified: true,
    authenticationTimeMs: Date.now(),
    ...overrides,
  };
}

function binding(overrides: Partial<AdminStepUpBinding> = {}): AdminStepUpBinding {
  return {
    adminUserId: 'admin-1',
    sessionId: 'sess-1',
    homeTenantId: 'default',
    targetTenantId: 'tenant-a',
    level: 'L1',
    operation: 'sessions.revoke_all',
    operationHash: 'hash-1',
    ...overrides,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<AdminStepUpError> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(AdminStepUpError);
  return error as AdminStepUpError;
}

describe('admin step-up policy', () => {
  it('uses the catalog level and lets a tenant only raise it', () => {
    expect(resolveAdminStepUpLevel('sessions.revoke_all')).toBe('L1');
    expect(resolveAdminStepUpLevel('sessions.revoke_all', { 'sessions.revoke_all': 'L2' })).toBe(
      'L2'
    );
    expect(resolveAdminStepUpLevel('tenant.delete', { 'tenant.delete': 'L1' })).toBe('L2');
    expect(resolveAdminStepUpLevel('tenant.delete', { 'tenant.delete': 'L0' })).toBe('L2');
    expect(resolveAdminStepUpLevel('tenant.delete', 'not a map')).toBe('L2');
  });

  it.each([
    [{}, null],
    [{ 'sessions.revoke_all': 'L2' }, null],
    [{ 'tenant.delete': 'L2' }, null],
    [[], 'must be an object'],
    [null, 'must be an object'],
    [{ 'users.list': 'L2' }, 'unknown operation'],
    [{ 'sessions.revoke_all': 'L3' }, 'must be L1 or L2'],
    [{ 'tenant.delete': 'L1' }, 'cannot be lowered'],
  ])('checks the overrides %j', (value, problem) => {
    const result = adminStepUpOverridesProblem(value);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toContain(problem);
  });
});

describe('createAdminStepUpOperationHash', () => {
  const base = {
    operation: 'admin.role.grant' as const,
    targetTenantId: 'tenant-a',
    targetIds: ['user-1', 'user-2'],
    params: { role: 'ar_tenant_admin', scope: { kind: 'tenant', id: 'tenant-a' } },
  };

  it('ignores key order, target order and duplicate targets', async () => {
    const hash = await createAdminStepUpOperationHash(base);
    await expect(
      createAdminStepUpOperationHash({
        targetIds: ['user-2', 'user-1', 'user-2'],
        params: { scope: { id: 'tenant-a', kind: 'tenant' }, role: 'ar_tenant_admin' },
        targetTenantId: 'tenant-a',
        operation: 'admin.role.grant',
      })
    ).resolves.toBe(hash);
  });

  it('keeps a __proto__ key in the parameters', async () => {
    const hashOf = (params: Record<string, unknown>) =>
      createAdminStepUpOperationHash({ ...base, params });
    const parse = (json: string): Record<string, unknown> =>
      JSON.parse(json) as Record<string, unknown>;
    const enabled = await hashOf(parse('{"config":{"__proto__":{"enabled":true}}}'));

    await expect(hashOf(parse('{"config":{"__proto__":{"enabled":false}}}'))).resolves.not.toBe(
      enabled
    );
    await expect(hashOf({ config: {} })).resolves.not.toBe(enabled);
  });

  it.each([
    ['operation', { operation: 'admin.role.revoke' as const }],
    ['target tenant', { targetTenantId: 'tenant-b' }],
    ['targets', { targetIds: ['user-1'] }],
    ['parameters', { params: { ...base.params, role: 'ar_viewer' } }],
    ['version', { resourceVersion: 3 }],
  ])('changes with the %s', async (_label, change) => {
    const hash = await createAdminStepUpOperationHash(base);
    await expect(createAdminStepUpOperationHash({ ...base, ...change })).resolves.not.toBe(hash);
  });
});

describe('evaluateAdminStepUpEvidence', () => {
  const now = 10_000_000;

  it('accepts a passkey inside the window for L1', () => {
    expect(
      evaluateAdminStepUpEvidence(human({ authenticationTimeMs: now - 1000 }), 'L1', now)
    ).toEqual({ missing: [], freshUntil: now - 1000 + ADMIN_STEP_UP_EVIDENCE_WINDOW_MS });
  });

  it.each([
    ['an old passkey', { authenticationTimeMs: now - ADMIN_STEP_UP_EVIDENCE_WINDOW_MS }],
    ['a passkey time in the future', { authenticationTimeMs: now + 1 }],
    ['no recorded time', { authenticationTimeMs: undefined }],
    ['a session without MFA', { mfaVerified: false }],
  ])('asks for a passkey with %s', (_label, overrides) => {
    expect(evaluateAdminStepUpEvidence(human(overrides), 'L1', now).missing).toEqual(['passkey']);
  });

  it('asks for a second factor on L2 when the session has none', () => {
    expect(
      evaluateAdminStepUpEvidence(human({ authenticationTimeMs: now }), 'L2', now).missing
    ).toEqual(['second_factor']);
  });

  it('meets L2 with both factors fresh, until the older one goes stale', () => {
    const auth = human({
      authenticationTimeMs: now - 1000,
      secondFactorId: 'sf-1',
      secondFactorVerifiedAtMs: now - 60_000,
    });
    expect(evaluateAdminStepUpEvidence(auth, 'L2', now)).toEqual({
      missing: [],
      freshUntil: now - 60_000 + ADMIN_STEP_UP_EVIDENCE_WINDOW_MS,
    });
  });

  it.each([
    [
      'only the passkey is fresh',
      {
        authenticationTimeMs: now,
        secondFactorId: 'sf-1',
        secondFactorVerifiedAtMs: now - ADMIN_STEP_UP_EVIDENCE_WINDOW_MS,
      },
      ['second_factor'],
    ],
    [
      'only the second factor is fresh',
      {
        authenticationTimeMs: now - ADMIN_STEP_UP_EVIDENCE_WINDOW_MS,
        secondFactorId: 'sf-1',
        secondFactorVerifiedAtMs: now,
      },
      ['passkey'],
    ],
    [
      'a second-factor time without its factor',
      { authenticationTimeMs: now, secondFactorVerifiedAtMs: now },
      ['second_factor'],
    ],
  ])('does not meet L2 when %s', (_label, overrides, missing) => {
    expect(evaluateAdminStepUpEvidence(human(overrides), 'L2', now).missing).toEqual(missing);
  });
});

describe('describeAdminStepUpFreshness', () => {
  const now = 10_000_000;

  it('reports until when each verified factor stays fresh', () => {
    expect(
      describeAdminStepUpFreshness(
        human({
          authenticationTimeMs: now - 1000,
          secondFactorId: 'factor-1',
          secondFactorVerifiedAtMs: now - 2000,
        }),
        now
      )
    ).toEqual({
      passkeyFreshUntil: now - 1000 + ADMIN_STEP_UP_EVIDENCE_WINDOW_MS,
      secondFactorFreshUntil: now - 2000 + ADMIN_STEP_UP_EVIDENCE_WINDOW_MS,
    });
  });

  it('reports null for a stale passkey, a session without MFA and a missing second factor', () => {
    expect(
      describeAdminStepUpFreshness(
        human({ authenticationTimeMs: now - ADMIN_STEP_UP_EVIDENCE_WINDOW_MS }),
        now
      )
    ).toEqual({ passkeyFreshUntil: null, secondFactorFreshUntil: null });
    expect(
      describeAdminStepUpFreshness(
        human({ mfaVerified: false, secondFactorVerifiedAtMs: now - 1000 }),
        now
      )
    ).toEqual({ passkeyFreshUntil: null, secondFactorFreshUntil: null });
  });
});

describe('requirements and receipts', () => {
  beforeEach(() => challenges.clear());

  it('issues one receipt for a requirement and uses it once', async () => {
    const { stepUpId } = await createAdminStepUpRequirement(env, binding());

    const issued = await issueAdminStepUpReceipt(env, { stepUpId, auth: human() });
    expect(issued.binding).toMatchObject(binding());
    expect(challenges.get(stepUpId)?.consumed).toBe(true);

    await expect(
      consumeAdminStepUpReceipt(env, issued.receipt, binding())
    ).resolves.toBeUndefined();
    expect((await errorOf(consumeAdminStepUpReceipt(env, issued.receipt, binding()))).code).toBe(
      'step_up_required'
    );
  });

  it('issues a single receipt when two issuances race', async () => {
    const { stepUpId } = await createAdminStepUpRequirement(env, binding());

    const results = await Promise.allSettled([
      issueAdminStepUpReceipt(env, { stepUpId, auth: human() }),
      issueAdminStepUpReceipt(env, { stepUpId, auth: human() }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect([...challenges.values()].filter((c) => c.type === 'admin_step_up_receipt')).toHaveLength(
      1
    );
  });

  it('keeps the requirement while evidence is missing', async () => {
    const { stepUpId } = await createAdminStepUpRequirement(env, binding());
    const stale = human({
      authenticationTimeMs: Date.now() - ADMIN_STEP_UP_EVIDENCE_WINDOW_MS - 1,
    });

    const error = await errorOf(issueAdminStepUpReceipt(env, { stepUpId, auth: stale }));
    expect(error.code).toBe('step_up_evidence_required');
    expect(error.missing).toEqual(['passkey']);
    expect(challenges.get(stepUpId)?.consumed).toBe(false);

    await expect(issueAdminStepUpReceipt(env, { stepUpId, auth: human() })).resolves.toMatchObject({
      binding: binding(),
    });
  });

  it('refuses L2 issuance without a verified second factor', async () => {
    const { stepUpId } = await createAdminStepUpRequirement(
      env,
      binding({ level: 'L2', operation: 'tenant.delete' })
    );

    const error = await errorOf(issueAdminStepUpReceipt(env, { stepUpId, auth: human() }));
    expect(error.missing).toEqual(['second_factor']);
  });

  describe('L2 with a verified second factor', () => {
    const l2 = binding({ level: 'L2', operation: 'tenant.delete' });
    const withFactor = () =>
      human({ secondFactorId: 'sf-1', secondFactorVerifiedAtMs: Date.now() - 1000 });

    it('issues the receipt while the factor is still active', async () => {
      const { stepUpId } = await createAdminStepUpRequirement(env, l2);
      const isSecondFactorActive = vi.fn(async () => true);

      const issued = await issueAdminStepUpReceipt(env, {
        stepUpId,
        auth: withFactor(),
        isSecondFactorActive,
      });

      expect(issued.binding).toMatchObject(l2);
      expect(isSecondFactorActive).toHaveBeenCalledWith('admin-1', 'sf-1');
    });

    it.each([
      ['the factor was revoked', async () => false],
      ['nothing can check the factor', undefined],
    ])('refuses and keeps the requirement when %s', async (_label, isSecondFactorActive) => {
      const { stepUpId } = await createAdminStepUpRequirement(env, l2);

      const error = await errorOf(
        issueAdminStepUpReceipt(env, { stepUpId, auth: withFactor(), isSecondFactorActive })
      );

      expect(error.code).toBe('step_up_evidence_required');
      expect(error.missing).toEqual(['second_factor']);
      expect(challenges.get(stepUpId)?.consumed).toBe(false);
    });
  });

  it.each([
    ['another admin', { userId: 'admin-2' }],
    ['another session', { sessionId: 'sess-2' }],
    ['another home tenant', { sessionTenantId: 'tenant-b' }],
    [
      'a machine caller',
      { authMethod: 'machine_access_token' as const, actorType: 'machine' as const },
    ],
    ['an agent', { actorType: 'agent' as const }],
    ['a session without its tenant', { sessionTenantId: undefined }],
  ])('refuses issuance for %s', async (_label, overrides) => {
    const { stepUpId } = await createAdminStepUpRequirement(env, binding());

    const error = await errorOf(issueAdminStepUpReceipt(env, { stepUpId, auth: human(overrides) }));
    expect(error.code).toBe('invalid_step_up');
    expect(challenges.get(stepUpId)?.consumed).toBe(false);
  });

  it.each(['asr_short', 'asp_' + 'a'.repeat(43), 'nope'])(
    'refuses a malformed step-up id %s',
    async (stepUpId) => {
      expect((await errorOf(issueAdminStepUpReceipt(env, { stepUpId, auth: human() }))).code).toBe(
        'invalid_step_up'
      );
    }
  );

  it('caps the receipt at the end of the evidence window', async () => {
    const now = Date.now();
    const verifiedAt = now - ADMIN_STEP_UP_EVIDENCE_WINDOW_MS + 30_000;
    const { stepUpId } = await createAdminStepUpRequirement(env, binding(), now);

    const issued = await issueAdminStepUpReceipt(env, {
      stepUpId,
      auth: human({ authenticationTimeMs: verifiedAt }),
      now,
    });

    expect(issued.expiresAt).toBe(verifiedAt + ADMIN_STEP_UP_EVIDENCE_WINDOW_MS);
    expect(issued.expiresAt).toBeLessThan(now + ADMIN_STEP_UP_RECEIPT_TTL_SECONDS * 1000);
  });

  it.each([
    ['admin', { adminUserId: 'admin-2' }],
    ['session', { sessionId: 'sess-2' }],
    ['target tenant', { targetTenantId: 'tenant-b' }],
    ['level', { level: 'L2' as const }],
    ['operation', { operation: 'client.secret.rotate' as const }],
    ['operation hash', { operationHash: 'hash-2' }],
  ])('spends a receipt presented for another %s', async (_label, change) => {
    const { stepUpId } = await createAdminStepUpRequirement(env, binding());
    const { receipt } = await issueAdminStepUpReceipt(env, { stepUpId, auth: human() });

    const error = await errorOf(consumeAdminStepUpReceipt(env, receipt, binding(change)));
    expect(error.code).toBe('step_up_required');
    await expect(
      errorOf(consumeAdminStepUpReceipt(env, receipt, binding()))
    ).resolves.toBeDefined();
  });

  it('does not accept a requirement id as a receipt', async () => {
    const { stepUpId } = await createAdminStepUpRequirement(env, binding());

    expect((await errorOf(consumeAdminStepUpReceipt(env, stepUpId, binding()))).code).toBe(
      'step_up_required'
    );
  });
});
