import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createContext,
  mocks,
  registrationCheck,
  resetDirectAuthMocks,
  webHeaders,
} from './helpers/mut-directauth-harness';

/**
 * Passkey sign-up start: the account it makes (and what it is made with), the records the finish
 * finds it by, the options of the ceremony, and its refusals (an address in use, attributes that
 * fail their check, an address not proven, a check that cannot be made).
 */
type Ctx = ReturnType<typeof createContext>;

async function signupStart(body: Record<string, unknown> = {}, prepare?: (c: Ctx) => void) {
  const { directPasskeySignupStartHandler } = await import('../direct-auth');
  const context = createContext(
    {
      client_id: 'web-client',
      code_challenge: 'signup-pkce-challenge',
      code_challenge_method: 'S256',
      channel: 'browser',
      ...body,
    },
    webHeaders()
  );
  prepare?.(context);
  const response = await directPasskeySignupStartHandler(context as never);
  return { response, body: await response.json<Record<string, unknown>>() };
}

function stored() {
  return mocks.challengeStore.storeChallengeRpc.mock.calls.map(
    ([request]) => request as { id: string; type: string; metadata?: Record<string, unknown> }
  );
}

function routed(c: Ctx) {
  c.get = ((key: string) => {
    if (key === 'tenantId') return 'tenant_test';
    if (key === 'tenantMetadataContext') {
      return { tenantId: 'tenant_test', route: { allocationScope: 'tenant_exclusive' } };
    }
    return undefined;
  }) as never;
}

describe('Direct Auth passkey sign-up start (mutation hardening)', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => {
    resetDirectAuthMocks();
    registrationCheck.override = null;
  });

  it('makes the account and the records its finish looks it up by', async () => {
    const { response, body } = await signupStart({ display_name: 'New User' });
    expect(response.status).toBe(200);
    expect(mocks.userCore.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_new' })
    );
    const [challenge, mapping] = stored();
    expect(challenge).toMatchObject({
      id: 'direct_passkey_signup:user_new',
      type: 'direct_passkey_signup',
      metadata: {
        code_challenge: 'signup-pkce-challenge',
        client_id: 'web-client',
        channel: 'browser',
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
        challenge_id: body.challenge_id,
      },
    });
    expect(challenge?.metadata).not.toHaveProperty('custom_fields');
    expect(challenge?.metadata).not.toHaveProperty('settle_after_email_check');
    expect(mapping).toMatchObject({
      id: `direct_passkey_signup_map:${String(body.challenge_id)}`,
      type: 'direct_passkey_signup_map',
      userId: 'user_new',
      challenge: body.challenge_id,
    });
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'app.example.com',
        userName: 'user_new',
        userDisplayName: 'New User',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      })
    );
  });

  it('excludes the account’s stored credentials and attaches the authenticator asked for', async () => {
    mocks.passkey.findByUserId.mockResolvedValue([
      { credential_id: '', transports: ['usb'] },
      { credential_id: 'AQID', transports: [] },
      { credential_id: 'BAUG', transports: ['internal'] },
    ]);
    await signupStart({ authenticator_type: 'cross-platform' });
    const options = mocks.generateRegistrationOptions.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.excludeCredentials).toEqual([
      { id: 'AQID', type: 'public-key', transports: undefined },
      { id: 'BAUG', type: 'public-key', transports: ['internal'] },
    ]);
    expect(options.authenticatorSelection).toMatchObject({
      authenticatorAttachment: 'cross-platform',
    });
  });

  it('keeps the checked registration fields with the challenge', async () => {
    mocks.validateRegistrationFieldSubmissionFromEnv.mockResolvedValue({
      ok: true,
      values: { team: 'blue' },
    });
    await signupStart({ custom_fields: { team: 'blue' } });
    expect(stored()[0]?.metadata).toMatchObject({ custom_fields: { team: 'blue' } });
  });

  it('refuses fields that fail their check, naming the missing ones', async () => {
    mocks.validateRegistrationFieldSubmissionFromEnv.mockResolvedValue({
      ok: false,
      error: 'missing',
      missingRequiredFields: [{ fieldKey: 'team', label: 'Team', fieldType: 'text' }],
    });
    const { response, body } = await signupStart({ custom_fields: {} });
    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error_code: 'AR130002',
      missing_required_fields: [{ field_key: 'team', label: 'Team', field_type: 'text' }],
    });
    expect(mocks.userCore.createUser).not.toHaveBeenCalled();
  });

  it('refuses fields that fail without naming fields', async () => {
    mocks.validateRegistrationFieldSubmissionFromEnv.mockResolvedValue({ ok: false, error: 'bad' });
    const { body } = await signupStart();
    expect(body.error_code).toBe('AR130002');
    expect(body).not.toHaveProperty('missing_required_fields');
  });

  it('asks for the address to be proven before a passkey sign-up with an email', async () => {
    const { response, body } = await signupStart({ email: 'New@Example.com' });
    expect(response.status).toBe(403);
    expect(body).toMatchObject({ error_code: 'AR050006', reason: 'signup_email_check_required' });
    expect(mocks.userCore.createUser).not.toHaveBeenCalled();
  });

  it('refuses an address that has an account', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
    });
    const { body } = await signupStart({ email: 'user@example.com' });
    expect(body.error_code).toBe('AR060005');
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('fails every address alike when the registration check cannot be made', async () => {
    registrationCheck.override = 'unavailable';
    const { response, body } = await signupStart({ email: 'new@example.com' });
    expect(response.status).toBe(500);
    expect(body.error_code).toBe('AR900001');
  });

  it('answers an internal error when the account cannot be made', async () => {
    mocks.userCore.createUser.mockRejectedValue(new Error('database down'));
    const { body } = await signupStart();
    expect(body.error_code).toBe('AR900001');
    expect(stored()).toHaveLength(0);
  });

  it('provisions a routed account with what it is made of', async () => {
    mocks.provisionTenantD1EmailAccount.mockResolvedValue({
      status: 'ready',
      accountId: 'account:user_new',
      userId: 'user_new',
    });
    const { response } = await signupStart({ display_name: 'Routed User' }, routed);
    expect(response.status).toBe(200);
    const input = mocks.provisionTenantD1EmailAccount.mock.calls[0]?.[1] as {
      candidateUserId: string;
      flow: string;
      runtimeUser: Record<string, unknown>;
    };
    expect(input.candidateUserId).toBe('user_new');
    expect(input.flow).toBe('passkey');
    expect(input.runtimeUser).toMatchObject({
      emailVerified: false,
      displayName: 'Routed User',
      sourceRef: 'auth:passkey',
      piiFields: { name: true },
      sensitiveValues: { name: 'Routed User' },
      customAttributesJson: JSON.stringify({ preferred_username: 'user_new' }),
    });
    expect(input.runtimeUser.piiFields).not.toHaveProperty('email');
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      expect.anything(),
      'account:user_new'
    );
    expect(mocks.createAccountAuthContextFromHono).toHaveBeenCalled();
    expect(mocks.userCore.createUser).not.toHaveBeenCalled();
  });

  it('provisions a routed account without a name with neither name field', async () => {
    await signupStart({}, routed);
    const input = mocks.provisionTenantD1EmailAccount.mock.calls[0]?.[1] as {
      runtimeUser: { piiFields: Record<string, unknown>; sensitiveValues: Record<string, unknown> };
    };
    expect(input.runtimeUser.piiFields).toEqual({});
    expect(input.runtimeUser.sensitiveValues).toEqual({});
  });
});
