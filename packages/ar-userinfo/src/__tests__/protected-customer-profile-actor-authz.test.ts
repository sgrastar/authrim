import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Actor–subject authorization for the customer-profile delegated-write route, exercised with the
 * DEFAULT actor validator and DEFAULT profile updater (only token introspection and the user store
 * are stubbed). Step-up runs through the real library against an in-memory challenge store.
 */

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  syncUser: vi.fn(),
  introspectTokenFromContext: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    introspectTokenFromContext: mocks.introspectTokenFromContext,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    CanonicalRuntimeUserStore: class {
      findById = mocks.findById;
      syncUser = mocks.syncUser;
    },
  };
});

import {
  createApp,
  createEnv,
  mintReceipt,
  patch,
  projection,
} from './helpers/customer-profile-write-harness';

/** An ordinary issuer-audience user access token for `sub`. */
function signInAs(sub: string) {
  mocks.introspectTokenFromContext.mockResolvedValue({
    valid: true,
    claims: { sub, aud: 'https://tenant.example.com', client_id: 'rp-1', scope: 'openid' },
  });
}

describe('customer profile delegated write: actor–subject authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccountDataContextFromHono.mockResolvedValue({ tenantId: 'tenant-a' });
    mocks.findById.mockImplementation(async (id: string) =>
      id === 'user-404' ? null : projection(id)
    );
    mocks.syncUser.mockResolvedValue(undefined);
  });

  securityRegressionIt(
    'refuses a PATCH on another user before issuing any step-up token',
    async () => {
      const { env, challengeStore } = createEnv();
      signInAs('user-attacker');
      const response = await patch(createApp(), env, {
        userId: 'user-victim',
        idempotencyKey: 'cross-user-no-receipt',
        body: { input: { email: 'attacker@example.com' } },
      });

      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload).toMatchObject({ error: 'access_denied' });
      expect(payload).not.toHaveProperty('step_up');
      expect(challengeStore.challenges.size).toBe(0);
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(mocks.syncUser).not.toHaveBeenCalled();
    }
  );

  securityRegressionIt(
    'refuses a PATCH on another user even with a receipt minted for that target',
    async () => {
      const { env } = createEnv();
      const input = { email: 'attacker@example.com' };
      const receipt = await mintReceipt({
        env,
        actorId: 'user-attacker',
        subjectUserId: 'user-victim',
        idempotencyKey: 'cross-user-with-receipt',
        bodyInput: input,
      });
      signInAs('user-attacker');
      const response = await patch(createApp(), env, {
        userId: 'user-victim',
        idempotencyKey: 'cross-user-with-receipt',
        body: { input },
        receipt,
      });

      expect(response.status).toBe(403);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ error: 'access_denied' });
      expect(text).not.toContain('user-victim@example.com');
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(mocks.syncUser).not.toHaveBeenCalled();
    }
  );

  securityRegressionIt(
    'answers a cross-user PATCH identically whether or not the target exists',
    async () => {
      const { env } = createEnv();
      signInAs('user-attacker');
      const app = createApp();
      const existing = await patch(app, env, {
        userId: 'user-victim',
        idempotencyKey: 'probe-existing',
        body: { input: { name: 'x' } },
      });
      const missing = await patch(app, env, {
        userId: 'user-404',
        idempotencyKey: 'probe-missing',
        body: { input: { name: 'x' } },
      });

      expect(existing.status).toBe(403);
      expect(missing.status).toBe(403);
      await expect(missing.json()).resolves.toEqual(await existing.json());
      expect(mocks.findById).not.toHaveBeenCalled();
    }
  );

  securityRegressionIt.each([
    ['a mapped sub with a sealed account reference', { authrim_subject_ref: 'sr1.iv.ciphertext' }],
    ['an externally asserted subject', { authrim_subject_issuer: 'https://external.example' }],
    ['a delegated token', { act: { sub: 'user-attacker' } }],
    ['a subject-principal claim', { authrim_subject_principal: 'client' }],
  ])('refuses a token whose sub equals the target but is %s', async (_label, extraClaims) => {
    const { env, challengeStore } = createEnv();
    mocks.introspectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: {
        sub: 'user-victim',
        aud: 'https://tenant.example.com',
        client_id: 'rp-1',
        token_use: 'access_token',
        jti: 'jti-1',
        ...extraClaims,
      },
    });
    const response = await patch(createApp(), env, {
      userId: 'user-victim',
      idempotencyKey: `mapped-sub-${Object.keys(extraClaims)[0]}`,
      body: { input: { email: 'attacker@example.com' } },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
    expect(challengeStore.challenges.size).toBe(0);
    expect(mocks.syncUser).not.toHaveBeenCalled();
  });

  securityRegressionIt('refuses a client principal whose sub is used as the path id', async () => {
    const { env, challengeStore } = createEnv();
    mocks.introspectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: { sub: 'client:rp-1', client_id: 'rp-1', token_use: 'access_token', jti: 'j' },
    });
    const response = await patch(createApp(), env, {
      userId: 'client:rp-1',
      idempotencyKey: 'client-principal',
      body: { input: { name: 'x' } },
    });

    expect(response.status).toBe(403);
    expect(challengeStore.challenges.size).toBe(0);
    expect(mocks.syncUser).not.toHaveBeenCalled();
  });

  securityRegressionIt('lets a user update their own profile with a receipt for it', async () => {
    const { env } = createEnv();
    const app = createApp();
    const input = { name: 'Self Updated' };
    signInAs('user-self');

    const challenge = await patch(app, env, {
      userId: 'user-self',
      idempotencyKey: 'self-update',
      body: { input },
    });
    expect(challenge.status).toBe(403);
    await expect(challenge.json()).resolves.toMatchObject({ error: 'step_up_required' });

    const receipt = await mintReceipt({
      env,
      actorId: 'user-self',
      subjectUserId: 'user-self',
      idempotencyKey: 'self-update',
      bodyInput: input,
    });
    const response = await patch(app, env, {
      userId: 'user-self',
      idempotencyKey: 'self-update',
      body: { input },
      receipt,
    });

    expect(response.status).toBe(200);
    expect(mocks.syncUser).toHaveBeenCalledTimes(1);
    expect(mocks.syncUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-self',
        sensitiveValues: { name: 'Self Updated' },
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      customer_profile: { sub: 'user-self' },
    });
  });

  securityRegressionIt(
    'does not serve the profile read route to an ordinary access token for another user',
    async () => {
      const { env } = createEnv();
      signInAs('user-attacker');
      const payload = Buffer.from(
        JSON.stringify({ sub: 'user-attacker', aud: 'https://tenant.example.com' })
      ).toString('base64url');
      const response = await createApp().request(
        'http://localhost/api/protected/customer-profiles/user-victim',
        { headers: { Authorization: `Bearer e30.${payload}.signature` } },
        env
      );

      expect(response.status).toBeGreaterThanOrEqual(401);
      expect(response.status).toBeLessThanOrEqual(403);
      expect(mocks.findById).not.toHaveBeenCalled();
    }
  );
});
