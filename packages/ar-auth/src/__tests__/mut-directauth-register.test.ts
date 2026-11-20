import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createContext,
  mocks,
  resetDirectAuthMocks,
  webHeaders,
} from './helpers/mut-directauth-harness';

/**
 * Adding a passkey to a signed-in account (register start/finish) and reading the session: the
 * session they are bound to, the challenge records they use, and what they store.
 */
type Ctx = ReturnType<typeof createContext>;

function routed(context: Ctx): Ctx {
  context.get = ((key: string) => {
    if (key === 'tenantId') return 'tenant_test';
    if (key === 'tenantMetadataContext') {
      return { tenantId: 'tenant_test', route: { allocationScope: 'tenant_exclusive' } };
    }
    return undefined;
  }) as never;
  return context;
}

async function json(response: Response) {
  return await response.json<Record<string, unknown>>();
}

const bearer = { ...webHeaders(), authorization: 'Bearer 0_session_existing' };

function registerChallenge(metadata: Record<string, unknown> = {}) {
  mocks.challengeStore.getChallengeRpc.mockResolvedValue({ userId: 'user_existing' });
  mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
    challenge: 'passkey-register-challenge',
    metadata: {
      origin: 'https://app.example.com',
      rpID: 'app.example.com',
      session_id: '0_session_existing',
      ...metadata,
    },
  });
}

function credential(transports?: string[]) {
  return {
    id: 'registered-credential',
    rawId: 'registered-credential',
    response: transports ? { transports } : {},
    type: 'public-key',
  };
}

async function registerFinish(body: Record<string, unknown>, context?: Ctx) {
  const { directPasskeyRegisterFinishHandler } = await import('../direct-auth');
  return directPasskeyRegisterFinishHandler((context ?? createContext(body)) as never);
}

async function registerStart(body: Record<string, unknown>, headers: Record<string, string>) {
  const { directPasskeyRegisterStartHandler } = await import('../direct-auth');
  return directPasskeyRegisterStartHandler(createContext(body, headers) as never);
}

describe('Direct Auth passkey registration for a signed-in account', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => resetDirectAuthMocks());

  it.each([
    [webHeaders(), 'AR000003'],
    [{ ...webHeaders(), authorization: 'Basic 0_session_existing' }, 'AR000003'],
    [{ ...webHeaders(), authorization: 'Bearer not-a-sharded-id' }, 'AR000001'],
  ])('asks for a session before a registration starts (%#)', async (headers, code) => {
    const response = await registerStart({}, headers);
    expect((await json(response)).error_code).toBe(code);
    expect(mocks.sessionStore.getSessionRpc).not.toHaveBeenCalled();
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('takes the session cookie before the Authorization header', async () => {
    mocks.getCookie.mockReturnValue('0_session_cookie');
    await registerStart({}, bearer);
    expect(mocks.sessionStore.getSessionRpc).toHaveBeenCalledWith('0_session_cookie');
  });

  it.each([
    [null],
    [{ id: '0_session_existing', userId: 'user_existing', expiresAt: Date.now() - 1 }],
  ])('refuses a session that is gone or expired (%#)', async (session) => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue(session);
    const response = await registerStart({}, bearer);
    expect((await json(response)).error_code).toBe('AR000001');
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('refuses a registration from an origin that is not allowed', async () => {
    const response = await registerStart(
      {},
      {
        origin: 'https://evil.example.net',
        host: 'app.example.com',
        authorization: bearer.authorization,
      }
    );
    expect((await json(response)).error_code).toBe('AR050006');
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('refuses a session whose account is gone', async () => {
    mocks.userCore.findById.mockResolvedValue(null);
    const response = await registerStart({}, bearer);
    expect((await json(response)).error_code).toBe('AR030001');
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('excludes only stored credentials, without empty transports, and attaches no type for any', async () => {
    mocks.passkey.findByUserId.mockResolvedValue([
      { credential_id: null, transports: ['usb'] },
      { credential_id: 'AQID', transports: [] },
    ]);
    const response = await registerStart({}, bearer);
    expect(response.status).toBe(200);
    const options = mocks.generateRegistrationOptions.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.excludeCredentials).toEqual([
      { id: 'AQID', type: 'public-key', transports: undefined },
    ]);
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(options.userDisplayName).toBe('Example User');
    const stored = mocks.challengeStore.storeChallengeRpc.mock.calls.map(([r]) => r as unknown);
    const mapId = (stored[0] as { metadata: { challenge_id: string } }).metadata.challenge_id;
    expect(stored[1]).toMatchObject({
      id: `direct_passkey_register_map:${mapId}`,
      type: 'direct_passkey_register_map',
      userId: 'user_existing',
      challenge: mapId,
    });
    expect(mocks.createAccountAuthContextFromHono).not.toHaveBeenCalled();
  });

  it('answers an internal error when the options cannot be made', async () => {
    mocks.generateRegistrationOptions.mockRejectedValue(new Error('boom'));
    const response = await registerStart({}, bearer);
    expect(response.status).toBe(500);
    expect((await json(response)).error_code).toBe('AR900001');
  });

  it.each([{ credential: credential() }, { challenge_id: 'register_challenge' }])(
    'needs both the challenge and the credential to finish (%#)',
    async (body) => {
      const response = await registerFinish(body);
      expect((await json(response)).error_code).toBe('AR130001');
      expect(mocks.challengeStore.getChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['no mapping', () => mocks.challengeStore.getChallengeRpc.mockResolvedValue(null)],
    [
      'mapping lookup fails',
      () => mocks.challengeStore.getChallengeRpc.mockRejectedValue(new Error('x')),
    ],
    [
      'challenge used',
      () => {
        registerChallenge();
        mocks.challengeStore.consumeChallengeRpc.mockRejectedValue(new Error('consumed'));
      },
    ],
    ['no session in challenge', () => registerChallenge({ session_id: undefined })],
    [
      'session gone',
      () => {
        registerChallenge();
        mocks.sessionStore.getSessionRpc.mockResolvedValue(null);
      },
    ],
    [
      'session of another user',
      () => {
        registerChallenge();
        mocks.sessionStore.getSessionRpc.mockResolvedValue({
          id: '0_session_existing',
          userId: 'user_other',
          expiresAt: Date.now() + 60_000,
        });
      },
    ],
  ])('treats a finish as expired: %s', async (_name, arrange) => {
    arrange();
    const response = await registerFinish({
      challenge_id: 'register_challenge',
      credential: credential(),
    });
    expect((await json(response)).error_code).toBe('AR000001');
    expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(mocks.passkey.create).not.toHaveBeenCalled();
  });

  it('looks the user up by the challenge mapping and consumes that user’s challenge', async () => {
    registerChallenge();
    await registerFinish({ challenge_id: 'register_challenge', credential: credential() });
    expect(mocks.challengeStore.getChallengeRpc).toHaveBeenCalledWith(
      'direct_passkey_register_map:register_challenge'
    );
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'direct_passkey_register:user_existing',
      tenantId: 'tenant_test',
      type: 'direct_passkey_register',
    });
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'passkey-register-challenge',
        expectedOrigin: 'https://app.example.com',
        expectedRPID: 'app.example.com',
      })
    );
  });

  it.each([
    [
      'verification throws',
      () => mocks.verifyRegistrationResponse.mockRejectedValue(new Error('bad')),
      'AR000005',
    ],
    [
      'not verified',
      () =>
        mocks.verifyRegistrationResponse.mockResolvedValue({
          verified: false,
          registrationInfo: {},
        }),
      'AR000005',
    ],
    [
      'no registration info',
      () => mocks.verifyRegistrationResponse.mockResolvedValue({ verified: true }),
      'AR000005',
    ],
    [
      'no credential id',
      () =>
        mocks.verifyRegistrationResponse.mockResolvedValue({
          verified: true,
          registrationInfo: { credentialPublicKey: new Uint8Array([1]) },
        }),
      'AR900001',
    ],
  ])('stores no passkey when %s', async (_name, arrange, code) => {
    registerChallenge();
    arrange();
    const response = await registerFinish({
      challenge_id: 'register_challenge',
      credential: credential(),
    });
    expect((await json(response)).error_code).toBe(code);
    expect(mocks.passkey.create).not.toHaveBeenCalled();
  });

  it('reads the credential of newer registration info and stores it with its counter', async () => {
    registerChallenge({ authenticator_type: 'cross-platform', display_name: 'From start' });
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: new Uint8Array([1, 2, 3]),
          publicKey: new Uint8Array([7, 7]),
          counter: 3,
        },
      },
    });
    const response = await registerFinish({
      challenge_id: 'register_challenge',
      credential: credential(['usb']),
    });
    const body = await json(response);
    expect(body).toMatchObject({
      credential_id: 'AQID',
      public_key: 'Bwc=',
      authenticator_type: 'cross-platform',
      transports: ['usb'],
    });
    expect(mocks.passkey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        credential_id: 'AQID',
        rp_id: 'app.example.com',
        counter: 3,
        device_name: 'From start',
        aaguid: null,
      })
    );
    expect(mocks.publishTenantD1PasskeyRoute).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant_test',
      userId: 'user_existing',
      passkeyId: expect.any(String) as unknown,
      credentialId: 'AQID',
      rpId: 'app.example.com',
    });
  });

  it('infers a platform authenticator from the internal transport and names a default device', async () => {
    registerChallenge();
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: new Uint8Array([4]),
        credentialPublicKey: new Uint8Array([5]),
      },
    });
    const response = await registerFinish({
      challenge_id: 'register_challenge',
      credential: credential(['internal']),
    });
    expect((await json(response)).authenticator_type).toBe('platform');
    expect(mocks.passkey.create).toHaveBeenCalledWith(
      expect.objectContaining({ counter: 0, device_name: 'Additional Passkey' })
    );
    expect(mocks.createAccountAuthContextFromHono).not.toHaveBeenCalled();
    expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
  });

  it('reports no transports and a cross-platform authenticator when none is known', async () => {
    registerChallenge();
    const response = await registerFinish({
      challenge_id: 'register_challenge',
      credential: credential(),
    });
    const body = await json(response);
    expect(body.authenticator_type).toBe('cross-platform');
    expect(body).not.toHaveProperty('transports');
  });

  it('stores the passkey in the account’s own database where accounts are routed', async () => {
    registerChallenge();
    const context = routed(
      createContext({ challenge_id: 'register_challenge', credential: credential() })
    );
    const response = await registerFinish({}, context);
    expect(response.status).toBe(200);
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(context, 'user_existing');
    expect(mocks.createAccountAuthContextFromHono).toHaveBeenCalled();
  });
});

describe('Direct Auth session read', () => {
  beforeEach(() => resetDirectAuthMocks());

  async function readSession(headers: Record<string, string>, context?: Ctx) {
    const { directSessionHandler } = await import('../direct-auth');
    return directSessionHandler((context ?? createContext({}, headers)) as never);
  }

  it.each([
    [{}, null, { error: 'no_session', error_description: 'No session found' }],
    [bearer, null, { error: 'session_expired', error_description: 'Session has expired' }],
  ])('answers 401 without a live session (%#)', async (headers, session, expected) => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue(session);
    const response = await readSession(headers);
    expect(response.status).toBe(401);
    expect(await json(response)).toEqual(expected);
  });

  it('answers 401 for an inactive account', async () => {
    mocks.userCore.findById.mockResolvedValue({ id: 'user_existing', is_active: false });
    const response = await readSession(bearer);
    expect(await json(response)).toEqual({
      error: 'user_not_found',
      error_description: 'User not found',
    });
  });

  it('returns the session without internal evidence and the user as stored', async () => {
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_existing',
      userId: 'user_existing',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      data: { amr: ['otp'], proven_at: 5, reauth_proven_at: 6, upstream_acr: 'x' },
    });
    const response = await readSession(bearer);
    const body = (await json(response)) as {
      session: { data: Record<string, unknown> };
      user: Record<string, unknown>;
    };
    expect(body.session.data).toEqual({ amr: ['otp'] });
    expect(body.user).toMatchObject({ id: 'user_existing', emailVerified: false });
    expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();

    mocks.userCore.findById.mockResolvedValue({
      id: 'user_existing',
      is_active: true,
      email_verified: true,
    });
    const verified = (await json(await readSession(bearer))) as { user: Record<string, unknown> };
    expect(verified.user.emailVerified).toBe(true);
  });

  it('resolves the account’s route before reading a routed account', async () => {
    const context = routed(createContext({}, bearer));
    const response = await readSession({}, context);
    expect(response.status).toBe(200);
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(context, 'user_existing');
  });
});
