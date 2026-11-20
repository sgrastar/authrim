import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createContext,
  enableEmailOtp,
  mocks,
  resetDirectAuthMocks,
  webHeaders,
} from './helpers/mut-directauth-harness';

/**
 * What the Direct Auth start and finish handlers refuse before any challenge, code or account is
 * touched: missing fields, a PKCE method other than S256, an unknown channel, a malformed address
 * or code, a provisioning resume named by halves, an invitation for another address, and the
 * email send limit.
 */
type Handler =
  | 'directPasskeyLoginStartHandler'
  | 'directPasskeyLoginFinishHandler'
  | 'directPasskeySignupStartHandler'
  | 'directPasskeySignupFinishHandler'
  | 'directEmailCodeSendHandler'
  | 'directEmailCodeVerifyHandler';

const start = {
  client_id: 'web-client',
  code_challenge: 'challenge',
  code_challenge_method: 'S256',
  channel: 'browser',
};
const emailStart = { ...start, email: 'user@example.com' };
const finish = {
  challenge_id: 'challenge_1',
  credential: { id: 'credential-id', rawId: 'credential-id', response: {}, type: 'public-key' },
  code_verifier: 'verifier',
  channel: 'browser',
};
const verify = {
  attempt_id: 'attempt_1',
  code: '123456',
  code_verifier: 'verifier',
  channel: 'browser',
};

async function call(handler: Handler, body: Record<string, unknown>, enableOtp = false) {
  const da = await import('../direct-auth');
  const context = createContext(body, webHeaders());
  if (enableOtp) enableEmailOtp(context);
  const response = await (da[handler] as (c: never) => Promise<Response>)(context as never);
  return { response, body: await response.json<Record<string, unknown>>() };
}

function nothingTouched() {
  expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  expect(mocks.getClient).not.toHaveBeenCalled();
  expect(mocks.rateLimiter.incrementRpc).not.toHaveBeenCalled();
}

const cases: Array<[Handler, Record<string, unknown>, string[]]> = [
  ['directPasskeyLoginStartHandler', start, ['client_id', 'code_challenge', 'channel']],
  ['directPasskeySignupStartHandler', start, ['client_id', 'code_challenge', 'channel']],
  ['directEmailCodeSendHandler', emailStart, ['client_id', 'email', 'code_challenge', 'channel']],
  [
    'directPasskeyLoginFinishHandler',
    finish,
    ['challenge_id', 'credential', 'code_verifier', 'channel'],
  ],
  [
    'directPasskeySignupFinishHandler',
    finish,
    ['challenge_id', 'credential', 'code_verifier', 'channel'],
  ],
  ['directEmailCodeVerifyHandler', verify, ['attempt_id', 'code', 'code_verifier', 'channel']],
];

describe('Direct Auth request validation', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => resetDirectAuthMocks());

  describe.each(cases)('%s', (handler, valid, required) => {
    it.each(required)('refuses a request without %s', async (field) => {
      const { response, body } = await call(handler, { ...valid, [field]: undefined });
      expect(response.status).toBe(400);
      expect(body.error_code).toBe('AR130001');
      nothingTouched();
    });

    it.each(['tv', 'Browser'])('refuses the unknown channel %s', async (channel) => {
      const { response, body } = await call(handler, { ...valid, channel });
      expect(response.status).toBe(400);
      expect(body.error_code).toBe('AR130003');
      nothingTouched();
    });
  });

  it.each([
    'directPasskeyLoginStartHandler',
    'directPasskeySignupStartHandler',
    'directEmailCodeSendHandler',
  ] as const)('%s takes S256 PKCE only', async (handler) => {
    const { body } = await call(handler, { ...emailStart, code_challenge_method: 'plain' });
    expect(body.error_code).toBe('AR130001');
    nothingTouched();
  });

  it.each(['native', 'server'])('accepts the %s channel as a channel', async (channel) => {
    mocks.getClient.mockResolvedValue(null);
    const { body } = await call('directEmailCodeSendHandler', { ...emailStart, channel });
    // Past the channel check: the client is looked up (and is unknown here).
    expect(body.error_code).toBe('AR020002');
  });

  it.each(['12345', '1234567', '12a456'])('refuses the email code %s', async (code) => {
    const { body } = await call('directEmailCodeVerifyHandler', { ...verify, code });
    expect(body.error_code).toBe('AR130003');
    nothingTouched();
  });

  it.each(['not-an-email', 'user@example', 'us er@example.com'])(
    'refuses the address %s before counting a send',
    async (email) => {
      const { body } = await call('directEmailCodeSendHandler', { ...emailStart, email });
      expect(body.error_code).toBe('AR130003');
      expect(mocks.rateLimiter.incrementRpc).not.toHaveBeenCalled();
    }
  );

  it('refuses a send for a client that is not known', async () => {
    mocks.getClient.mockResolvedValue(null);
    const { body } = await call('directEmailCodeSendHandler', emailStart);
    expect(body.error_code).toBe('AR020002');
    expect(mocks.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  describe('passkey sign-up resume of a provisioning', () => {
    it.each([{ provisioning_token: 'token' }, { resume_user_id: 'user_new' }])(
      'refuses half of a resume (%j)',
      async (resume) => {
        const { body } = await call('directPasskeySignupStartHandler', { ...start, ...resume });
        expect(body.error_code).toBe('AR130003');
        expect(mocks.resolvePasskeyProvisioningResumeUserId).not.toHaveBeenCalled();
        expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
      }
    );

    it('refuses a resume whose token does not name the user', async () => {
      mocks.resolvePasskeyProvisioningResumeUserId.mockResolvedValue(null);
      const { body } = await call('directPasskeySignupStartHandler', {
        ...start,
        provisioning_token: 'token',
        resume_user_id: 'user_new',
      });
      expect(body.error_code).toBe('AR130003');
      expect(mocks.resolvePasskeyProvisioningResumeUserId).toHaveBeenCalledWith(
        expect.anything(),
        'token',
        'user_new'
      );
      expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
    });

    it('refuses an invite token that is not a non-empty string', async () => {
      const { body } = await call('directPasskeySignupStartHandler', {
        ...start,
        invite_token: '',
      });
      expect(body.error_code).toBe('AR130003');
      expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
    });
  });

  describe('email code send', () => {
    it('refuses an unknown invitation and one for another address', async () => {
      const unknown = await call('directEmailCodeSendHandler', {
        ...emailStart,
        invite_token: 't',
      });
      expect(unknown.response.status).toBe(404);

      mocks.findActiveInvitationByToken.mockResolvedValue({
        id: 'inv_1',
        tenant_id: 'tenant_test',
        invited_email: 'someone@example.com',
      });
      const other = await call('directEmailCodeSendHandler', { ...emailStart, invite_token: 't' });
      expect(other.body.error_code).toBe('AR000006');
      expect(mocks.rateLimiter.incrementRpc).not.toHaveBeenCalled();
    });

    it('matches the invited address whatever its case', async () => {
      mocks.findActiveInvitationByToken.mockResolvedValue({
        id: 'inv_1',
        tenant_id: 'tenant_test',
        invited_email: 'User@Example.com',
      });
      await call('directEmailCodeSendHandler', { ...emailStart, invite_token: 't' }, true);
      expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalled();
    });

    it.each([
      ['a', true],
      ['i'.repeat(128), true],
      ['i'.repeat(129), false],
      ['', false],
    ])('holds an interaction id of length %#  to its tenant (refused: %s)', async (id, refused) => {
      mocks.findActiveInvitationByToken.mockResolvedValue({
        id: 'inv_1',
        tenant_id: 'tenant_other',
        invited_email: null,
      });
      const { body } = await call(
        'directEmailCodeSendHandler',
        { ...emailStart, invite_token: 't', runtime_interaction_id: id },
        true
      );
      if (refused) {
        expect(body.error_code).toBe('AR130003');
        expect(mocks.rateLimiter.incrementRpc).not.toHaveBeenCalled();
      } else {
        expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalled();
      }
    });

    it('counts a send per lower-cased address and refuses one over the limit', async () => {
      mocks.rateLimiter.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 120 });
      const { response, body } = await call(
        'directEmailCodeSendHandler',
        { ...emailStart, email: 'User@Example.COM' },
        true
      );
      expect(response.status).toBe(429);
      expect(body.error_code).toBe('AR110001');
      expect(body.error_description).toContain('retry after 120 seconds');
      expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalledWith(
        'direct_email_code:user@example.com',
        expect.objectContaining({
          windowSeconds: expect.any(Number) as unknown,
          maxRequests: expect.any(Number) as unknown,
        })
      );
      expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
      expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    });
  });
});
