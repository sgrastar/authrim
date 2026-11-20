import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, mocks, resetDirectAuthMocks } from './helpers/mut-directauth-harness';

/**
 * consumeAuthorizationChallengeContinuation: which proof may answer an authorization challenge
 * (method, freshness, user), each refusal with its own OAuth error and description, and the
 * challenge left unused by a refused proof.
 */
const NOW = 1_700_000_000_000;

function contextFor() {
  const context = Object.assign(createContext({}), { header: vi.fn() });
  return context;
}

function storedChallenge(type: 'login' | 'reauth', metadata: Record<string, unknown> = {}) {
  return {
    id: 'authz_1',
    tenantId: 'tenant_test',
    type,
    userId: 'user_existing',
    metadata: { issuer: 'https://issuer.example.com', ...metadata },
  };
}

async function consume(
  provenMethod?: 'passkey' | 'email_otp' | 'directory_password',
  provenAtMs?: number,
  context = contextFor()
) {
  const { consumeAuthorizationChallengeContinuation } = await import('../direct-auth');
  const result = await consumeAuthorizationChallengeContinuation(
    context as never,
    'tenant_test',
    'authz_1',
    'user_existing',
    Math.floor(NOW / 1000),
    'https://fallback.example.com',
    provenMethod,
    provenAtMs
  );
  if ('error' in result) {
    return { status: result.error.status, body: await result.error.json<unknown>(), context };
  }
  return { status: 200, body: result as unknown, context };
}

describe('authorization challenge continuation (mutation hardening)', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => resetDirectAuthMocks());

  it('refuses a re-authentication by no known method, leaving the challenge', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(storedChallenge('reauth'));
    expect(await consume(undefined, NOW)).toMatchObject({
      status: 403,
      body: {
        error: 'access_denied',
        error_description: 'This method cannot be used to re-authenticate',
      },
    });
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses a re-authentication by a method whose switch cannot be read', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(storedChallenge('reauth'));
    const context = contextFor();
    context.env.SETTINGS = { get: vi.fn().mockRejectedValue(new Error('kv down')) } as never;
    const { status, body } = await consume('passkey', NOW, context);
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'access_denied' });

    // With the switch readable (on by default), the same proof answers it.
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(storedChallenge('reauth'));
    expect((await consume('passkey', NOW)).status).toBe(200);
  });

  it.each([
    ['login', { fresh_sign_in_after: NOW + 1 }, 'Sign in again to continue to this application'],
    [
      'reauth',
      { reauth_issued_at: NOW + 1 },
      'Authenticate again to complete the re-authentication',
    ],
  ] as const)(
    'refuses a %s proof older than the challenge',
    async (type, metadata, description) => {
      mocks.challengeStore.getChallengeRpc.mockResolvedValue(storedChallenge(type, metadata));
      expect(await consume('directory_password', NOW)).toMatchObject({
        status: 403,
        body: { error: 'login_required', error_description: description },
      });
      expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it('refuses a re-authentication by another user than the one it was asked of', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(
      storedChallenge('reauth', { sessionUserId: 'user_other' })
    );
    expect(await consume('directory_password', NOW)).toMatchObject({
      status: 403,
      body: {
        error: 'access_denied',
        error_description: 'Authenticated user does not match the re-authentication challenge',
      },
    });
  });

  it('answers 503 when the challenge cannot be read, consuming nothing', async () => {
    mocks.challengeStore.getChallengeRpc.mockRejectedValue(new Error('store down'));
    expect(await consume('passkey', NOW)).toMatchObject({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'The authorization request could not be checked',
      },
    });
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('answers 503 when a used challenge’s confirmation cannot be read', async () => {
    mocks.challengeStore.getChallengeRpc
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('store down'));
    expect(await consume('passkey', NOW)).toMatchObject({
      status: 503,
      body: { error: 'temporarily_unavailable' },
    });
  });

  it.each([
    [
      'gone with no confirmation',
      () => mocks.challengeStore.getChallengeRpc.mockResolvedValue(null),
    ],
    [
      'not consumable as either kind',
      () => {
        mocks.challengeStore.getChallengeRpc.mockResolvedValue(undefined);
        mocks.challengeStore.consumeChallengeRpc.mockRejectedValue(new Error('not found'));
      },
    ],
  ])('refuses a challenge %s as invalid or expired', async (_n, arrange) => {
    arrange();
    expect(await consume('passkey', NOW)).toMatchObject({
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'Authorization challenge is invalid or expired',
      },
    });
  });

  it('consumes a login challenge and leaves a confirmation the browser is bound to', async () => {
    const challenge = storedChallenge('login');
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challenge);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challenge);
    const { status, body, context } = await consume('passkey', NOW);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      type: 'login',
      redirectUrl: expect.stringContaining('https://issuer.example.com') as unknown,
    });
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'authz_1',
      tenantId: 'tenant_test',
      type: 'login',
      challenge: 'authz_1',
    });
    const confirmation = mocks.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
      userId: string;
      metadata: Record<string, unknown>;
    };
    expect(confirmation.userId).toBe('user_existing');
    expect(confirmation.metadata).toMatchObject({
      purpose: 'authorize_confirmation',
      source_challenge_id: 'authz_1',
      continuation_type: 'login',
      continuation_issuer: 'https://issuer.example.com',
      continuation_requirement: {},
      sessionUserId: 'user_existing',
    });
    expect(confirmation.metadata).not.toHaveProperty('reauth_issued_at');
    expect(context.header).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringMatching(/^authrim_authorize_confirmation=.+; Path=\/authorize; HttpOnly;/),
      { append: true }
    );
  });

  it('tries the re-authentication kind first for a stored re-authentication', async () => {
    const challenge = storedChallenge('reauth', {
      reauth_issued_at: NOW - 1,
      assurance_step_up: { from: 'aal1' },
    });
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challenge);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challenge);
    const { status } = await consume('directory_password', NOW);
    expect(status).toBe(200);
    expect(mocks.challengeStore.consumeChallengeRpc.mock.calls[0]?.[0]).toMatchObject({
      type: 'reauth',
    });
    const confirmation = mocks.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(confirmation.metadata).toMatchObject({
      continuation_type: 'reauth',
      continuation_requirement: { reauth_issued_at: NOW - 1, session_user_id: 'user_existing' },
      reauth_issued_at: NOW - 1,
      assurance_step_up: { from: 'aal1' },
    });
  });
});
