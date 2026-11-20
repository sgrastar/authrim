/**
 * The authorization challenge a start is given: which ones are accepted for which target, and what
 * the request context takes from it (its scope and the standard claims it asks for).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import {
  challenge,
  createContext,
  insertedInteraction,
  mocks,
  mockStart,
  readJson,
  resetHarness,
} from './helpers/mut-runtime1-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal())
);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).icebergMock(await importOriginal())
);
vi.mock('../direct-auth', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).directAuthMock(await importOriginal())
);

const oidcBody = {
  flow_kind: 'login',
  client_id: 'client_1',
  authorization_challenge_id: 'login_challenge_1',
};

async function start(body: Record<string, unknown>) {
  const response = await loginRuntimeInteractionStartHandler(createContext({ body }));
  return { status: response.status, data: await readJson(response) };
}

const samlChallenge = (overrides: Record<string, unknown> = {}) =>
  challenge({
    type: 'reauth',
    metadata: {
      client_id: undefined,
      protocol: 'saml',
      saml_request_id: 'req_1',
      saml_sp_entity_id: 'https://sp.example.test',
      tenant_id: 'tenant_test',
    },
    ...overrides,
  });
const samlBody = {
  flow_kind: 'login',
  saml_sp_id: 'https://sp.example.test',
  saml_request_id: 'req_1',
  authorization_challenge_id: 'login_challenge_1',
};

beforeEach(() => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
});

describe('which authorization challenges a start accepts', () => {
  it('refuses a challenge for a start that is not for an OIDC client or a SAML SP', async () => {
    const { status, data } = await start({
      flow_kind: 'login',
      authorization_challenge_id: 'login_challenge_1',
    });
    expect(status).toBe(400);
    expect(data).toMatchObject({
      error: 'invalid_authorization_challenge',
      error_description:
        'Authorization challenge can only be used with an OIDC client or SAML SP Flow target',
      error_code: 'AR_FLOW_AUTH_CHALLENGE_INVALID',
    });
    expect(mocks.getChallengeStoreByChallengeId).not.toHaveBeenCalled();
  });

  it.each([
    ['a challenge that is gone', null],
    ['a challenge of another tenant', challenge({ tenantId: 'tenant_other' })],
    ['a used challenge', challenge({ consumed: true })],
  ])('answers that the request expired for %s', async (_label, stored) => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(stored);
    const { status, data } = await start(oidcBody);
    expect(status).toBe(400);
    expect(data).toMatchObject({
      error: 'authorization_request_expired',
      error_code: 'AR_FLOW_AUTH_REQUEST_EXPIRED',
    });
    expect(String(data.error_description)).not.toBe('');
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('answers that the request expired when the challenge store cannot be reached', async () => {
    mocks.getChallengeStoreByChallengeId.mockRejectedValueOnce(new Error('unreachable'));
    const { status, data } = await start(oidcBody);
    expect(status).toBe(400);
    expect(data.error).toBe('authorization_request_expired');
  });

  it('reads the challenge from the tenant store it is sharded to', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(challenge());
    mockStart();
    expect((await start(oidcBody)).status).toBe(200);
    expect(mocks.getChallengeStoreByChallengeId).toHaveBeenCalledWith(
      expect.anything(),
      'login_challenge_1',
      'tenant_test'
    );
    expect(mocks.challengeStore.getChallengeRpc).toHaveBeenCalledWith('login_challenge_1');
  });

  it('refuses a challenge that is not of a sign-in', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(challenge({ type: 'consent' }));
    const { status, data } = await start(oidcBody);
    expect(status).toBe(400);
    expect(data).toMatchObject({
      error: 'invalid_authorization_challenge',
      error_description: 'Authorization challenge is invalid or expired',
      error_code: 'AR_FLOW_AUTH_CHALLENGE_INVALID',
    });
  });

  it('accepts a re-authentication challenge of the client', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(challenge({ type: 'reauth' }));
    mockStart();
    expect((await start(oidcBody)).status).toBe(200);
  });

  it.each([
    ['the challenge of a SAML request', samlChallenge({ type: 'login' })],
    ['a challenge without a client', challenge({ metadata: { client_id: '  ' } })],
    ['a challenge of another client', challenge({ metadata: { client_id: 'client_2' } })],
  ])('refuses %s for an OIDC client', async (_label, stored) => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(stored);
    const { status, data } = await start(oidcBody);
    expect(status).toBe(403);
    expect(data).toMatchObject({
      error: 'authorization_challenge_mismatch',
      error_description: 'Authorization challenge does not match the requested client',
      error_code: 'AR_FLOW_AUTH_CHALLENGE_MISMATCH',
    });
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('accepts the SAML challenge bound to the request and SP of the start', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(samlChallenge());
    mockStart();
    const { status } = await start(samlBody);
    expect(status).toBe(200);
    // A SAML request asks for no scope or claims.
    expect(insertedInteraction().context).toMatchObject({
      protocol: 'saml',
      authorization_challenge_id: 'login_challenge_1',
      requested_scope: [],
    });
    expect(insertedInteraction().context.requested_claims).toBeUndefined();
  });

  it.each([
    ['an OIDC challenge', challenge({ type: 'reauth' })],
    ['a challenge of another SAML request', samlChallenge(), { saml_request_id: 'req_2' }],
  ])('refuses %s for a SAML SP', async (_label, stored, extra: Record<string, unknown> = {}) => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(stored);
    const { status, data } = await start({ ...samlBody, ...extra });
    expect(status).toBe(403);
    expect(data).toMatchObject({
      error: 'authorization_challenge_mismatch',
      error_description: 'Authorization challenge does not match the requested SAML request',
      error_code: 'AR_FLOW_AUTH_CHALLENGE_MISMATCH',
    });
  });
});

describe('what a start takes from the authorization request', () => {
  async function startWith(metadata: Record<string, unknown>, body: Record<string, unknown> = {}) {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(challenge({ metadata }));
    mockStart();
    const { status, data } = await start({ ...oidcBody, ...body });
    expect(status).toBe(200);
    return { context: insertedInteraction().context, data };
  }

  it('takes the scope of the request over the one the caller sends', async () => {
    const { context, data } = await startWith(
      { scope: 'openid  email openid' },
      { scope: 'openid profile address' }
    );
    expect(context.requested_scope).toEqual(['openid', 'email']);
    expect(data.contract).toMatchObject({
      protocol_context: {
        protocol: 'oidc',
        oidc: { client_id: 'client_1', requested_scope: ['openid', 'email'] },
      },
    });
  });

  it('keeps the scope the caller sends when the request has none', async () => {
    const { context } = await startWith({}, { scope: ' openid  profile ' });
    expect(context.requested_scope).toEqual(['openid', 'profile']);
  });

  it('keeps the standard claims the claims parameter names, each once', async () => {
    const { context } = await startWith({
      claims: JSON.stringify({
        id_token: { email: null, custom_level: null },
        userinfo: { email: { essential: true }, name: null, __proto__x: null },
      }),
    });
    expect(context.requested_claims).toEqual(['email', 'name']);
  });

  it('reads claims of the userinfo or the ID token alone', async () => {
    expect(
      (await startWith({ claims: JSON.stringify({ userinfo: { phone_number: null } }) })).context
        .requested_claims
    ).toEqual(['phone_number']);
    resetHarness();
    clearLoginRuntimeFlowVersionCacheForTests();
    expect(
      (await startWith({ claims: JSON.stringify({ id_token: { address: null } }) })).context
        .requested_claims
    ).toEqual(['address']);
  });

  it('asks for no claims without a claims parameter, or with one that is not a string', async () => {
    expect((await startWith({})).context.requested_claims).toEqual([]);
    resetHarness();
    clearLoginRuntimeFlowVersionCacheForTests();
    expect(
      (await startWith({ claims: { id_token: { email: null } } })).context.requested_claims
    ).toEqual([]);
  });
});
