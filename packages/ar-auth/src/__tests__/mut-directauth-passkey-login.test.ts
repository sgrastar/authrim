import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  attemptRecording,
  createContext,
  createMockKV,
  mocks,
  resetDirectAuthMocks,
  s256Challenge,
  webHeaders,
} from './helpers/mut-directauth-harness';

/**
 * Passkey login finish: every refusal after its challenge is consumed is recorded against the
 * challenge's Flow interaction with its own reason, and only a verified assertion of the account
 * the challenge allows makes an artifact.
 */
const VERIFIER = 'passkey-login-code-verifier';
type Ctx = ReturnType<typeof createContext>;

async function loginChallenge(metadata: Record<string, unknown> = {}) {
  mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
    challenge: 'passkey-login-challenge',
    metadata: {
      code_challenge: await s256Challenge(VERIFIER),
      client_id: 'web-client',
      channel: 'browser',
      origin: 'https://app.example.com',
      rpID: 'app.example.com',
      attempt_interaction_id: 'int-1',
      ...metadata,
    },
  });
}

function credential(response: Record<string, unknown> = {}) {
  return { id: 'credential-id', rawId: 'credential-id', response, type: 'public-key' };
}

async function loginFinish(body: Record<string, unknown> = {}, prepare?: (c: Ctx) => void) {
  const { directPasskeyLoginFinishHandler } = await import('../direct-auth');
  const context = createContext({
    challenge_id: 'challenge_1',
    credential: credential(),
    code_verifier: VERIFIER,
    channel: 'browser',
    ...body,
  });
  prepare?.(context);
  const response = await directPasskeyLoginFinishHandler(context as never);
  return { response, body: await response.json<Record<string, unknown>>() };
}

function recorded() {
  return attemptRecording.record.mock.calls.map(
    (call) => call[3] as { reasonCode: string; userId: string | null; interactionId: string }
  );
}

function passkeySettings(values: Record<string, boolean>) {
  return (c: Ctx) => {
    c.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify(values),
    }) as never;
  };
}

describe('Direct Auth passkey login finish (mutation hardening)', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => resetDirectAuthMocks());

  it('answers an expired session for a challenge that cannot be consumed, recording nothing', async () => {
    mocks.challengeStore.consumeChallengeRpc.mockRejectedValue(new Error('Challenge not found'));
    const { body } = await loginFinish();
    expect(body.error_code).toBe('AR000001');
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'direct_passkey_login:challenge_1',
      tenantId: 'tenant_test',
      type: 'direct_passkey_login',
    });
    expect(attemptRecording.record).not.toHaveBeenCalled();
  });

  it.each([
    ['login', { 'authentication-methods.passkey.login_enabled': false }, true],
    ['reauth', { 'authentication-methods.passkey.reauth_enabled': false }, true],
    ['login', { 'authentication-methods.passkey.reauth_enabled': false }, false],
  ])('checks the %s switch again at finish (%#)', async (usage, settings, refused) => {
    await loginChallenge({ usage, reauth_user_id: 'user_existing' });
    const { response, body } = await loginFinish({}, passkeySettings(settings));
    if (refused) {
      expect(body.error_code).toBe('AR050006');
      expect(recorded()).toEqual([expect.objectContaining({ reasonCode: 'method_disabled' })]);
      expect(mocks.passkey.findByCredentialId).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
    }
  });

  it.each([
    ['a verifier for another challenge', { code_verifier: 'another-verifier' }, {}],
    ['another channel', { channel: 'native' }, {}],
    ['a challenge without a code challenge', {}, { code_challenge: undefined }],
  ])('refuses %s as a challenge mismatch', async (_n, body, metadata) => {
    await loginChallenge(metadata);
    const result = await loginFinish(body);
    expect(result.body.error_code).toBe('AR000006');
    expect(recorded()).toEqual([
      {
        tenantId: 'tenant_test',
        interactionId: 'int-1',
        method: 'passkey',
        reasonCode: 'challenge_mismatch',
        userId: null,
      },
    ]);
    expect(mocks.passkey.findByCredentialId).not.toHaveBeenCalled();
  });

  describe('where accounts are routed', () => {
    const routedContext = (c: Ctx) => {
      c.get = ((key: string) => {
        if (key === 'tenantId') return 'tenant_test';
        if (key === 'tenantMetadataContext') {
          return { tenantId: 'tenant_test', route: { allocationScope: 'tenant_exclusive' } };
        }
        return undefined;
      }) as never;
    };
    const ownHandle = 'dXNlcl9leGlzdGluZw';

    it('records a passkey route it cannot resolve as the service being unavailable', async () => {
      await loginChallenge();
      mocks.resolveAccountDataContextByIdentifierFromHono.mockRejectedValue(new Error('down'));
      const { body } = await loginFinish({}, routedContext);
      expect(body.error_code).toBe('AR000005');
      expect(recorded()).toEqual([expect.objectContaining({ reasonCode: 'service_unavailable' })]);
      expect(mocks.passkey.findByCredentialId).not.toHaveBeenCalled();
    });

    it.each([
      ['another account’s route', 'user_other', ownHandle],
      ['no user handle', 'user_existing', undefined],
      ['another user handle', 'user_existing', 'b3RoZXI'],
    ])('refuses a routed passkey with %s', async (_n, legacyUserId, userHandle) => {
      await loginChallenge();
      mocks.resolveAccountDataContextByIdentifierFromHono.mockResolvedValue({ legacyUserId });
      const { body } = await loginFinish({ credential: credential({ userHandle }) }, routedContext);
      expect(body.error_code).toBe('AR000005');
      expect(recorded()).toEqual([expect.objectContaining({ reasonCode: 'account_mismatch' })]);
      expect(mocks.createAccountAuthContextFromHono).toHaveBeenCalled();
    });

    it('takes a routed passkey of the route’s account with its own user handle', async () => {
      await loginChallenge();
      mocks.resolveAccountDataContextByIdentifierFromHono.mockResolvedValue({
        legacyUserId: 'user_existing',
      });
      const { response } = await loginFinish(
        { credential: credential({ userHandle: ownHandle }) },
        routedContext
      );
      expect(response.status).toBe(200);
    });
  });

  it('finds a passkey stored under its legacy base64 id and rewrites the id', async () => {
    await loginChallenge();
    const stored = {
      id: 'passkey_1',
      user_id: 'user_existing',
      credential_id: 'legacy',
      public_key: 'AQID',
      counter: 4,
    };
    mocks.passkey.findByCredentialId.mockResolvedValueOnce(null).mockResolvedValueOnce(stored);
    const { response } = await loginFinish();
    expect(response.status).toBe(200);
    expect(mocks.passkey.findByCredentialId.mock.calls[1]?.[0]).not.toBe('credential-id');
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      'UPDATE passkeys SET credential_id = ? WHERE id = ? AND tenant_id = ?',
      ['credential-id', 'passkey_1', 'tenant_test']
    );
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({ id: 'credential-id' }) as unknown,
      })
    );
  });

  it('publishes an unknown credential as a failed passkey of its client', async () => {
    await loginChallenge({ client_id: undefined });
    mocks.passkey.findByCredentialId.mockResolvedValue(null);
    await loginFinish();
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: { method: 'passkey', clientId: 'direct-auth', errorCode: 'credential_not_found' },
      })
    );
  });

  it.each([
    ['a re-authentication of another user', { usage: 'reauth', reauth_user_id: 'user_other' }, {}],
    ['a user handle of another user', {}, { userHandle: 'b3RoZXI' }],
    ['an empty user handle', {}, { userHandle: '' }],
  ])('refuses %s as an account mismatch', async (_n, metadata, response) => {
    await loginChallenge(metadata);
    const { body } = await loginFinish({ credential: credential(response) });
    expect(body.error_code).toBe('AR000005');
    expect(recorded()).toEqual([
      expect.objectContaining({ reasonCode: 'account_mismatch', userId: 'user_existing' }),
    ]);
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('takes the user handle and re-authentication of the passkey’s own user', async () => {
    await loginChallenge({ usage: 'reauth', reauth_user_id: 'user_existing' });
    const userHandle = 'dXNlcl9leGlzdGluZw';
    const { response } = await loginFinish({ credential: credential({ userHandle }) });
    expect(response.status).toBe(200);
    expect(attemptRecording.record).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', () => mocks.verifyAuthenticationResponse.mockRejectedValue(new Error('bad'))],
    [
      'is not verified',
      () =>
        mocks.verifyAuthenticationResponse.mockResolvedValue({
          verified: false,
          authenticationInfo: { newCounter: 5 },
        }),
    ],
  ])('records a failed verification when the assertion %s', async (_n, arrange) => {
    await loginChallenge();
    arrange();
    const { body } = await loginFinish();
    expect(body.error_code).toBe('AR000005');
    expect(recorded()).toEqual([
      expect.objectContaining({ reasonCode: 'verification_failed', userId: 'user_existing' }),
    ]);
    expect(mocks.advancePasskeyCounterRpc).not.toHaveBeenCalled();
  });

  it('records an account without authentication state as unavailable', async () => {
    await loginChallenge();
    mocks.userCore.findById.mockResolvedValue(null);
    const { body } = await loginFinish();
    expect(body.error_code).toBe('AR000005');
    expect(recorded()).toEqual([expect.objectContaining({ reasonCode: 'account_unavailable' })]);
  });

  it.each([
    [new Error('account_authentication_not_allowed'), 400, 'AR030001'],
    [new Error('lifecycle store down'), 503, undefined],
  ])('records a guest that may not sign in (%#)', async (error, status, code) => {
    await loginChallenge();
    const core = await import('@authrim/ar-lib-core');
    (
      core.assertGuestCredentialAuthenticationAllowed as unknown as {
        mockRejectedValueOnce: (e: Error) => void;
      }
    ).mockRejectedValueOnce(error);
    const { response, body } = await loginFinish();
    expect(response.status).toBe(status);
    if (code) expect(body.error_code).toBe(code);
    else
      expect(body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'Authentication state unavailable.',
      });
    expect(recorded()).toEqual([expect.objectContaining({ reasonCode: 'guest_denied' })]);
    expect(mocks.advancePasskeyCounterRpc).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('passkey_counter_replay'), 'replay_detected'],
    [new Error('account_authentication_not_allowed'), 'account_unavailable'],
  ])('records a refused authentication state as %s', async (error, reason) => {
    await loginChallenge();
    mocks.advancePasskeyCounterRpc.mockRejectedValue(error);
    const { body } = await loginFinish();
    expect(body.error_code).toBe('AR000005');
    expect(recorded()).toEqual([expect.objectContaining({ reasonCode: reason })]);
  });

  it('answers 503 with Retry-After when the authentication state cannot be advanced', async () => {
    await loginChallenge();
    mocks.advancePasskeyCounterRpc.mockRejectedValue(new Error('store down'));
    const { response, body } = await loginFinish();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Authentication state unavailable.',
    });
    expect(recorded()).toEqual([expect.objectContaining({ reasonCode: 'service_unavailable' })]);
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('makes an artifact bound to the challenge and its interaction', async () => {
    await loginChallenge({ scope: 'openid', authorization_challenge_id: undefined });
    const { response, body } = await loginFinish();
    expect(response.status).toBe(200);
    const stored = mocks.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
      id: string;
      type: string;
      userId: string;
      metadata: Record<string, unknown>;
    };
    expect(stored.id).toBe(`direct_auth:${String(body.direct_auth_artifact)}`);
    expect(stored.type).toBe('direct_auth_code');
    expect(stored.userId).toBe('user_existing');
    expect(stored.metadata).toMatchObject({
      method: 'passkey',
      client_id: 'web-client',
      channel: 'browser',
      scope: 'openid',
      transaction_id: 'challenge_1',
      passkey_id: 'passkey_1',
      attempt_interaction_id: 'int-1',
      proven_at: expect.any(Number) as unknown,
    });
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_existing',
        clientId: 'web-client',
        scope: 'openid',
        codeChallengeMethod: 'S256',
      })
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: { userId: 'user_existing', method: 'passkey', clientId: 'web-client' },
      })
    );
  });

  it('makes no interaction binding for an artifact of a challenge without one', async () => {
    await loginChallenge({ attempt_interaction_id: undefined, transaction_id: 'tx_1' });
    await loginFinish();
    const stored = mocks.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(stored.metadata).not.toHaveProperty('attempt_interaction_id');
    expect(stored.metadata.transaction_id).toBe('tx_1');
  });
});

describe('Direct Auth passkey login start (mutation hardening)', () => {
  beforeEach(() => resetDirectAuthMocks());

  async function loginStart(headers: Record<string, string> = webHeaders()) {
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');
    const response = await directPasskeyLoginStartHandler(
      createContext(
        {
          client_id: 'web-client',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
        },
        headers
      ) as never
    );
    return { response, body: await response.json<Record<string, unknown>>() };
  }

  it('stores the challenge under the id it returns, with no re-authentication user for a login', async () => {
    const { body } = await loginStart();
    const stored = mocks.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
      id: string;
      metadata: Record<string, unknown>;
    };
    expect(stored.id).toBe(`direct_passkey_login:${String(body.challenge_id)}`);
    expect(stored.metadata).toMatchObject({ usage: 'login', transaction_id: body.challenge_id });
    expect(stored.metadata).not.toHaveProperty('reauth_user_id');
  });

  it('fails the start when the interaction it names cannot be checked', async () => {
    attemptRecording.resolve.mockRejectedValueOnce(new Error('interaction store down'));
    const { response, body } = await loginStart({
      ...webHeaders(),
      'x-authrim-interaction-id': 'int-1',
    });
    expect(response.status).toBe(500);
    expect(body.error_code).toBe('AR900001');
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses an unknown client and an origin that is not allowed', async () => {
    mocks.getClient.mockResolvedValueOnce(null);
    expect((await loginStart()).body.error_code).toBe('AR020002');
    mocks.getWebOriginRegistry.mockResolvedValue({ origins: [] });
    mocks.getClient.mockResolvedValue({ client_id: 'web-client', application_type: 'web' });
    const refused = await loginStart({
      origin: 'https://evil.example.net',
      host: 'app.example.com',
    });
    expect(refused.body.error_code).toBe('AR050006');
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
  });
});
