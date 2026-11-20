import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createContext,
  enableEmailOtp,
  mocks,
  resetDirectAuthMocks,
  webHeaders,
} from './helpers/mut-directauth-harness';

/**
 * An email verification presentation completes an email-code send only when everything about
 * it holds: the browser channel, its challenge (as read and as consumed), the Flow interaction at
 * one of its steps, and a verified presentation. Anything less falls back to sending a code.
 */
const protocolMetadata = {
  interaction_id: 'interaction_1',
  expected_origin: 'https://app.example.com',
  source_step_id: 'auth:step',
  verification_step_id: 'email-verify:step',
  contract_hash: 'contract_hash',
};

function protocolChallenge(
  read: Record<string, unknown> = {},
  consumed: Record<string, unknown> = {}
) {
  mocks.challengeStore.getChallengeRpc.mockResolvedValue({
    challenge: 'protocol-nonce',
    tenantId: 'tenant_test',
    type: 'email_verification_protocol',
    metadata: protocolMetadata,
    ...read,
  });
  mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
    challenge: 'protocol-nonce',
    metadata: protocolMetadata,
    ...consumed,
  });
}

async function send(body: Record<string, unknown> = {}) {
  const { directEmailCodeSendHandler } = await import('../direct-auth');
  const response = await directEmailCodeSendHandler(
    enableEmailOtp(
      createContext(
        {
          client_id: 'web-client',
          email: 'existing@example.com',
          code_challenge: 'email-pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          email_verification_token: 'presentation-token',
          email_verification_challenge_id: 'challenge_1',
          runtime_interaction_id: 'interaction_1',
          ...body,
        },
        webHeaders()
      )
    ) as never
  );
  return await response.json<Record<string, unknown>>();
}

function completedByPresentation(body: Record<string, unknown>) {
  return typeof body.direct_auth_artifact === 'string';
}

describe('Direct Auth email verification presentation (mutation hardening)', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => {
    resetDirectAuthMocks();
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    mocks.verifyEmailVerificationProtocol.mockResolvedValue({ verified: true });
  });

  it('completes the sign-in with the interaction at its verification step', async () => {
    protocolChallenge();
    mocks.coreAdapter.queryOne.mockResolvedValue({
      state: 'created',
      current_step_id: 'email-verify:step',
      contract_hash: 'contract_hash',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    expect(completedByPresentation(await send())).toBe(true);
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('falls back to a code for a channel other than the browser', async () => {
    mocks.getClient.mockResolvedValue({
      client_id: 'web-client',
      allowed_channels: ['browser', 'native'],
      allowed_redirect_origins: ['https://app.example.com'],
    });
    protocolChallenge();
    const body = await send({ channel: 'native' });
    expect(completedByPresentation(body)).toBe(false);
    expect(mocks.verifyEmailVerificationProtocol).not.toHaveBeenCalled();
  });

  it('falls back to a code without a challenge id', async () => {
    protocolChallenge();
    const body = await send({ email_verification_challenge_id: '' });
    expect(completedByPresentation(body)).toBe(false);
    expect(mocks.verifyEmailVerificationProtocol).not.toHaveBeenCalled();
  });

  it.each([
    ['another type', { type: 'direct_email_code' }],
    ['another tenant', { tenantId: 'tenant_other' }],
    ['no nonce', { challenge: '' }],
    ['another interaction', { metadata: { ...protocolMetadata, interaction_id: 'interaction_2' } }],
    [
      'another origin',
      { metadata: { ...protocolMetadata, expected_origin: 'https://evil.example.net' } },
    ],
    ['no contract hash', { metadata: { ...protocolMetadata, contract_hash: undefined } }],
    ['no metadata', { metadata: undefined }],
  ])('falls back to a code for a challenge of %s', async (_n, read) => {
    protocolChallenge(read);
    const body = await send();
    expect(completedByPresentation(body)).toBe(false);
    expect(mocks.verifyEmailVerificationProtocol).not.toHaveBeenCalled();
  });

  it.each([
    ['finished', { state: 'completed' }],
    ['expired', { expires_at: Math.floor(Date.now() / 1000) - 1 }],
    ['of another contract', { contract_hash: 'other' }],
    ['at another step', { current_step_id: 'other:step' }],
  ])('falls back to a code when the interaction is %s', async (_n, interaction) => {
    protocolChallenge();
    mocks.coreAdapter.queryOne.mockResolvedValue({
      state: 'active',
      current_step_id: 'auth:step',
      contract_hash: 'contract_hash',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      ...interaction,
    });
    expect(completedByPresentation(await send())).toBe(false);
    expect(mocks.verifyEmailVerificationProtocol).not.toHaveBeenCalled();
  });

  it('falls back to a code when the interaction cannot be read', async () => {
    protocolChallenge();
    mocks.coreAdapter.queryOne.mockRejectedValue(new Error('db down'));
    expect(completedByPresentation(await send())).toBe(false);
  });

  it.each([
    ['throws', () => mocks.verifyEmailVerificationProtocol.mockRejectedValue(new Error('bad'))],
    [
      'is not verified',
      () => mocks.verifyEmailVerificationProtocol.mockResolvedValue({ verified: false }),
    ],
  ])('falls back to a code when the presentation %s', async (_n, arrange) => {
    protocolChallenge();
    arrange();
    expect(completedByPresentation(await send())).toBe(false);
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'email_verification_protocol' })
    );
  });

  it.each([
    ['another nonce', { challenge: 'other-nonce' }],
    ['other metadata', { metadata: { ...protocolMetadata, interaction_id: 'interaction_2' } }],
  ])('falls back to a code when the consumed challenge has %s', async (_n, consumed) => {
    protocolChallenge({}, consumed);
    expect(completedByPresentation(await send())).toBe(false);
  });

  it('falls back to a code when the interaction moved on while the challenge was consumed', async () => {
    protocolChallenge();
    const live = {
      state: 'active',
      current_step_id: 'auth:step',
      contract_hash: 'contract_hash',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    };
    let checks = 0;
    mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (!sql.includes('SELECT state, current_step_id, contract_hash, expires_at')) return live;
      checks += 1;
      return checks === 1 ? live : { ...live, state: 'completed' };
    });
    expect(completedByPresentation(await send())).toBe(false);
    expect(mocks.verifyEmailVerificationProtocol).toHaveBeenCalledTimes(1);
  });
});
