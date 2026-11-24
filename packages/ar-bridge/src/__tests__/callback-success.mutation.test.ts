/**
 * External callback: a completed sign-in (authorization code, or SSO session and handoff).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec, callArg, rec } from './helpers/mock-args';
import {
  M,
  REQUEST_CONTEXT,
  T0,
  TOKENS,
  ready,
  setupCallbackMocks,
} from './helpers/callback-mocks';
import { ExternalIdPErrorCode } from '../types';
import {
  ENV,
  STATE,
  authState,
  callback,
  fakeExecutionContext,
  locationOf,
  must,
  oauthProvider,
  oidcProvider,
  paramsOf,
} from './helpers/callback-harness';

beforeEach(setupCallbackMocks);

const lastHandleIdentityInput = () => argRec(M.handleIdentity, 0, 1);

describe('a completed sign-in', () => {
  it('exchanges the code and hands the OAuth2 userinfo to identity resolution', async () => {
    await callback();
    expect(M.decrypt).toHaveBeenCalledWith('encrypted-secret', 'encryption-key');
    expect(M.fromProvider).toHaveBeenCalledWith(
      oauthProvider,
      'https://auth.example.com/auth/external/corp/callback',
      'upstream-secret'
    );
    expect(M.exchangeCode).toHaveBeenCalledWith('upstream-code', 'verifier-a');
    expect(M.fetchUserInfo).toHaveBeenCalledWith('upstream-access');
    expect(M.handleIdentity).toHaveBeenCalledTimes(1);
    const { loadSignUpPolicy, ...handed } = lastHandleIdentityInput();
    expect(typeof loadSignUpPolicy).toBe('function');
    expect(M.handleIdentity.mock.calls[0]?.[0]).toBe(ENV);
    expect(handed).toEqual({
      provider: oauthProvider,
      userInfo: { sub: 'ext-sub', email: 'new@example.com', name: 'New Person' },
      tokens: TOKENS,
      mappedCustomClaims: undefined,
      upstreamClaims: undefined,
      linkingUserId: undefined,
      tenantId: 'default',
    });
  });

  it('uses the provider id in the callback URL when it has no slug', async () => {
    M.getProvider.mockResolvedValue({ ...oauthProvider, slug: undefined });
    await callback();
    expect(M.fromProvider.mock.calls[0]?.[1]).toBe(
      'https://auth.example.com/auth/external/provider-a/callback'
    );
  });

  it('requires the code verifier and the encryption key', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ codeVerifier: undefined }));
    expect(paramsOf(await callback()).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.exchangeCode).not.toHaveBeenCalled();
    M.fromProvider.mockClear();
    M.consumeAuthState.mockResolvedValue(authState());
    M.getKey.mockReturnValue(undefined);
    expect(paramsOf(await callback()).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.fromProvider).not.toHaveBeenCalled();
  });

  it('fails when the identity carries no subject, with the mapping hint', async () => {
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { email: 'x@example.com' },
      endpoint: 'e',
      signedResponse: false,
    });
    const response = await callback();
    expect(paramsOf(response)).toEqual({
      error: ExternalIdPErrorCode.CALLBACK_FAILED,
      error_description:
        'Provider did not return a user identifier. Check attributeMapping configuration.',
    });
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });

  it('applies the attribute mapping, turning a numeric sub into a string', async () => {
    M.getProvider.mockResolvedValue({
      ...oauthProvider,
      attributeMapping: { sub: 'id', email: 'contact.mail', picture: 'missing.path' },
    });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { id: 42, contact: { mail: 'm@example.com' }, picture: 'kept.png' },
      endpoint: 'e',
      signedResponse: false,
    });
    await callback();
    expect(lastHandleIdentityInput().userInfo).toEqual({
      id: 42,
      contact: { mail: 'm@example.com' },
      picture: 'kept.png',
      sub: '42',
      email: 'm@example.com',
    });
  });

  it('keeps non-sub numbers as numbers and walks null or primitive path segments to undefined', async () => {
    M.getProvider.mockResolvedValue({
      ...oauthProvider,
      attributeMapping: { sub: 'a', age: 'n', deep: 'x.y.z', gone: 'nul.prop' },
    });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { a: 'sub-a', n: 7, x: { y: 'str' }, nul: null },
      endpoint: 'e',
      signedResponse: false,
    });
    await callback();
    expect(lastHandleIdentityInput().userInfo).toEqual({
      a: 'sub-a',
      n: 7,
      x: { y: 'str' },
      nul: null,
      sub: 'sub-a',
      age: 7,
    });
  });

  it('uses the inbound mapping result instead of the attribute mapping when there is one', async () => {
    const claims = { sub: 'ext-sub', email: 'new@example.com', name: 'New Person' };
    M.inbound.mockResolvedValue({ userInfo: { sub: 'mapped-sub' }, customClaims: { dept: 'x' } });
    await callback();
    expect(M.inbound).toHaveBeenCalledWith(ENV, 'default', oauthProvider, claims);
    expect(lastHandleIdentityInput()).toMatchObject({
      userInfo: { sub: 'mapped-sub' },
      mappedCustomClaims: { dept: 'x' },
      upstreamClaims: claims,
    });
  });

  it('passes invitation, creation and sign-up policy only where they apply', async () => {
    M.consumeAuthState.mockResolvedValue(
      authState({ inviteId: 'inv', inviteReservationId: 'res', attemptInteractionId: 'int-1' })
    );
    M.requirement.mockResolvedValue({ email: 'only@example.com' });
    M.liteMode.mockResolvedValue('always');
    await callback();
    expect(M.requirement).toHaveBeenCalledWith(ENV, { tenantId: 'default', inviteId: 'inv' });
    const input = lastHandleIdentityInput();
    expect(input.invitation).toEqual({ email: 'only@example.com' });
    expect(input.accountCreationAllowed).toBe(false);
    expect(input).not.toHaveProperty('reauthentication');
    await (input.loadSignUpPolicy as () => Promise<void>)();
    expect(M.loadPolicy).toHaveBeenCalledWith(ENV, 'default', 'int-1');
  });

  it('omits those inputs for a plain sign-in, and flags a re-authentication', async () => {
    await callback();
    const plain = lastHandleIdentityInput();
    expect(plain).not.toHaveProperty('invitation');
    expect(plain).not.toHaveProperty('accountCreationAllowed');
    expect(plain).not.toHaveProperty('reauthentication');
    expect(typeof plain.loadSignUpPolicy).toBe('function');
    expect(M.requirement).not.toHaveBeenCalled();
  });

  it('does not release the invitation once the sign-in created the account, but does otherwise', async () => {
    const reserved = authState({ inviteId: 'inv', inviteReservationId: 'res' });
    M.consumeAuthState.mockResolvedValue(reserved);
    M.handleIdentity.mockResolvedValue(ready({ isNewUser: true }));
    await callback();
    expect(M.release).not.toHaveBeenCalled();
    M.handleIdentity.mockResolvedValue(ready({ isNewUser: false }));
    await callback();
    expect(M.release).toHaveBeenCalledTimes(1);
  });

  it('applies the invitation to the account it created, before issuing anything', async () => {
    M.consumeAuthState.mockResolvedValue(
      authState({ inviteId: 'inv', inviteReservationId: 'res' })
    );
    M.handleIdentity.mockResolvedValue(ready({ isNewUser: true }));
    await callback();
    expect(M.apply).toHaveBeenCalledWith(ENV, expect.anything(), {
      inviteId: 'inv',
      inviteReservationId: 'res',
      tenantId: 'default',
      userId: 'user-1',
      accountCoreAdapter: M.coreAdapter,
    });
    M.apply.mockClear();
    M.handleIdentity.mockResolvedValue(ready({ isNewUser: false }));
    await callback();
    expect(M.apply).not.toHaveBeenCalled();
  });

  it('resolves the external-subject account context for the new session', async () => {
    await callback();
    expect(M.resolveAccount).toHaveBeenCalledWith(ENV, {
      tenantId: 'default',
      indexKind: 'external_subject',
      identifier: { issuer: 'provider-a', subject: 'ext-sub' },
      expectedAccountId: 'account:user-1',
    });
  });

  it('publishes the success event and tolerates a failing publish', async () => {
    M.publishEvent.mockRejectedValue(new Error('bus down'));
    const response = await callback();
    expect(response.status).toBe(302);
    expect(M.publishEvent).toHaveBeenCalledWith(expect.anything(), {
      type: 'auth.external_idp.succeeded',
      tenantId: 'default',
      data: { userId: 'user-1', method: 'external_idp', clientId: 'provider-a' },
    });
    expect(M.errorLog).toHaveBeenCalledWith(
      'Failed to publish auth.external_idp.succeeded',
      {},
      expect.any(Error)
    );
  });

  describe('without SSO: an authorization code', () => {
    it('stores a one-use code bound to the client challenge and redirects with it', async () => {
      M.handleIdentity.mockResolvedValue(ready({ isNewUser: true, stitchedFromExisting: false }));
      const response = await callback();
      expect(response.status).toBe(302);
      const location = locationOf(response);
      expect(location.origin + location.pathname).toBe('https://login.example.com/callback');
      const code = must(location.searchParams.get('code'));
      expect([...location.searchParams.keys()]).toEqual(['code']);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(M.getStore).toHaveBeenCalledWith(ENV, code, 'default');
      expect(M.store.storeChallengeRpc).toHaveBeenCalledWith({
        id: `direct_auth:${code}`,
        tenantId: 'default',
        type: 'direct_auth_code',
        userId: 'user-1',
        challenge: 'code-challenge-a',
        ttl: 60,
        metadata: {
          method: 'external_idp',
          provider: 'provider-a',
          provider_id: 'provider-a',
          provider_slug: 'corp',
          client_id: 'client-a',
          is_new_user: true,
          stitched_from_existing: false,
          usage: 'signup',
          created_at: T0,
        },
      });
      expect(M.createSession).not.toHaveBeenCalled();
    });

    it('records the interaction, upstream acr and re-authentication proof when present', async () => {
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      M.consumeAuthState.mockResolvedValue(
        authState({ attemptInteractionId: 'int-1', reauthRequestedAt: T0 - 1000, maxAge: 0 })
      );
      M.exchangeCode.mockResolvedValue({
        tokens: { ...TOKENS, id_token: 'id.token.jwt' },
        requestContext: REQUEST_CONTEXT,
      });
      M.validateIdToken.mockResolvedValue({
        sub: 'ext-sub',
        iss: 'https://idp.example.com',
        auth_time: Math.floor(T0 / 1000),
        acr: 'urn:acr:2',
      });
      M.reauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });
      await callback();
      const metadata = rec(argRec(M.store.storeChallengeRpc, 0, 0).metadata);
      expect(metadata).toMatchObject({
        attempt_interaction_id: 'int-1',
        upstream_acr: 'urn:acr:2',
        reauth_proven_amr: ['external_idp'],
        reauth_proven_at: T0 - 1000,
      });
      expect(metadata).not.toHaveProperty('usage');
    });

    it('omits the optional metadata for an existing account', async () => {
      await callback();
      const metadata = rec(argRec(M.store.storeChallengeRpc, 0, 0).metadata);
      expect(metadata).not.toHaveProperty('attempt_interaction_id');
      expect(metadata).not.toHaveProperty('usage');
      expect(metadata).not.toHaveProperty('upstream_acr');
      expect(metadata).not.toHaveProperty('reauth_proven_at');
      expect(metadata.provider_slug).toBe('corp');
      M.getProvider.mockResolvedValue({ ...oauthProvider, slug: undefined });
      M.store.storeChallengeRpc.mockClear();
      await callback();
      expect(rec(argRec(M.store.storeChallengeRpc, 0, 0).metadata).provider_slug).toBe(
        'provider-a'
      );
    });

    it('fails without a code challenge or client id in the state', async () => {
      M.consumeAuthState.mockResolvedValue(authState({ codeChallenge: undefined }));
      expect(paramsOf(await callback()).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
      M.consumeAuthState.mockResolvedValue(authState({ clientId: undefined }));
      expect(paramsOf(await callback()).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
      expect(M.store.storeChallengeRpc).not.toHaveBeenCalled();
    });
  });

  describe('with SSO: a session and a handoff', () => {
    const sso = (overrides = {}) => authState({ enableSso: true, ...overrides });

    it('creates the session, sets its cookie and redirects with a handoff token', async () => {
      M.consumeAuthState.mockResolvedValue(sso());
      const waitUntil = vi.fn();
      const response = await callback({
        executionCtx: fakeExecutionContext(waitUntil),
      });
      expect(M.runtimeStoreArgs).toHaveBeenCalledWith({
        coreAdapter: M.coreAdapter,
        piiAdapter: M.piiAdapter,
        tenantId: 'default',
      });
      expect(M.findById).toHaveBeenCalledWith('user-1');
      expect(M.sessionProfile).toHaveBeenCalledWith(ENV, {
        tenantId: 'default',
        interactionId: undefined,
        challengeId: undefined,
        provider: oauthProvider,
        isNewUser: false,
      });
      expect(M.getSessionStore).toHaveBeenCalledWith(ENV, 'default');
      expect(M.createSession).toHaveBeenCalledWith(
        'session-a',
        'user-1',
        1800,
        {
          email: 'new@example.com',
          name: 'New Person',
          amr: ['external_idp'],
          acr: 'urn:mace:incommon:iap:bronze',
          client_id: 'client-a',
          external_idp: 'provider-a',
          external_provider_id: 'provider-a',
          external_provider_sub: 'ext-sub',
          external_provider_sid: undefined,
          upstream_id_token_encrypted: undefined,
          snap: 'shot',
        },
        'default'
      );
      expect(M.registerProviderSession).toHaveBeenCalledWith(ENV, {
        tenantId: 'default',
        providerId: 'provider-a',
        providerSub: 'ext-sub',
        providerSid: undefined,
        sessionId: 'session-a',
        userId: 'user-1',
        expiresAtMs: T0 + 1_800_000,
      });
      expect(waitUntil).toHaveBeenCalledTimes(1);
      const cookie = must(response.headers.get('Set-Cookie'));
      expect(cookie).toContain('authrim_session=session-a');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=1800');
      const location = locationOf(response);
      const token = must(location.searchParams.get('handoff_token'));
      expect(location.searchParams.get('state')).toBe(STATE);
      expect(M.store.storeChallengeRpc).toHaveBeenCalledWith({
        id: `handoff:${token}`,
        tenantId: 'default',
        type: 'handoff',
        userId: 'user-1',
        challenge: 'session-a',
        ttl: 30,
        metadata: {
          client_id: 'client-a',
          state: STATE,
          aud: 'handoff',
          created_at: T0,
          external_provider_usage_key: { providerId: 'provider-a', ids: ['provider-a', 'corp'] },
        },
      });
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('stores the encrypted upstream id token, the sid, the acr and the interaction', async () => {
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      M.consumeAuthState.mockResolvedValue(sso({ flowChallengeId: 'ch-1' }));
      M.exchangeCode.mockResolvedValue({
        tokens: { ...TOKENS, id_token: 'id.token.jwt' },
        requestContext: REQUEST_CONTEXT,
      });
      M.validateIdToken.mockResolvedValue({
        sub: 'ext-sub',
        sid: 'op-sid',
        acr: 'urn:acr:1',
        email: 'x@example.com',
      });
      M.sessionProfile.mockResolvedValue({
        allowed: true,
        interactionId: 'int-9',
        profiled: { ttl: { seconds: 600 }, snapshot: {} },
      });
      M.handleIdentity.mockResolvedValue(ready({ isNewUser: true }));
      await callback();
      expect(M.encrypt).toHaveBeenCalledWith('id.token.jwt', 'encryption-key');
      const attributes = rec(callArg(M.createSession, 0, 3));
      expect(attributes).toMatchObject({
        external_provider_sid: 'op-sid',
        upstream_id_token_encrypted: 'encrypted-id-token',
        upstream_acr: 'urn:acr:1',
        runtime_interaction_id: 'int-9',
      });
      expect(M.sessionProfile).toHaveBeenCalledWith(
        ENV,
        expect.objectContaining({
          challengeId: 'ch-1',
          isNewUser: true,
        })
      );
      expect(rec(argRec(M.store.storeChallengeRpc, 0, 0).metadata)).toMatchObject({
        external_provider_usage: 'signup',
      });
    });

    it('does not keep the id token without an encryption key, nor a non-string sid or acr', async () => {
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      M.consumeAuthState.mockResolvedValue(sso());
      M.getKey.mockReturnValueOnce('encryption-key'); // client secret
      M.getKey.mockReturnValue(undefined);
      M.exchangeCode.mockResolvedValue({
        tokens: { ...TOKENS, id_token: 'id.token.jwt' },
        requestContext: REQUEST_CONTEXT,
      });
      M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', sid: 5, acr: 'a'.repeat(1025) });
      await callback();
      const attributes = rec(callArg(M.createSession, 0, 3));
      expect(attributes.upstream_id_token_encrypted).toBeUndefined();
      expect(attributes.external_provider_sid).toBeUndefined();
      expect(attributes).not.toHaveProperty('upstream_acr');
      expect(M.encrypt).not.toHaveBeenCalled();
    });

    it('keeps an upstream acr of exactly 1024 characters and drops an empty one', async () => {
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      M.consumeAuthState.mockResolvedValue(sso());
      M.exchangeCode.mockResolvedValue({
        tokens: { ...TOKENS, id_token: 'id.token.jwt' },
        requestContext: REQUEST_CONTEXT,
      });
      M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', acr: 'a'.repeat(1024) });
      await callback();
      expect(argRec(M.createSession, 0, 3).upstream_acr).toBe('a'.repeat(1024));
      M.createSession.mockClear();
      M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', acr: '' });
      await callback();
      expect(argRec(M.createSession, 0, 3)).not.toHaveProperty('upstream_acr');
    });

    it('uses a plain-http issuer for a non-secure session cookie', async () => {
      M.consumeAuthState.mockResolvedValue(sso());
      const response = await callback({
        env: { ...ENV, ISSUER_URL: 'http://localhost:8787' },
      });
      expect(must(response.headers.get('Set-Cookie'))).not.toContain('Secure');
    });

    it('marks the handoff as sign-up for a finished account creation, and omits usage for re-authentication', async () => {
      M.consumeAuthState.mockResolvedValue(sso());
      M.handleIdentity.mockResolvedValue(ready({ finishedAccountCreation: true }));
      await callback();
      expect(rec(argRec(M.store.storeChallengeRpc, 0, 0).metadata)).toMatchObject({
        external_provider_usage: 'signup',
      });
      M.store.storeChallengeRpc.mockClear();
      M.createSession.mockClear();
      M.getProvider.mockResolvedValue({ ...oidcProvider });
      M.consumeAuthState.mockResolvedValue(sso({ reauthRequestedAt: T0 - 1000 }));
      M.exchangeCode.mockResolvedValue({
        tokens: { ...TOKENS, id_token: 'id.token.jwt' },
        requestContext: REQUEST_CONTEXT,
      });
      M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', auth_time: Math.floor(T0 / 1000) });
      M.reauthPolicy.mockResolvedValue({ reauthEnabled: true });
      await callback();
      const metadata = rec(argRec(M.store.storeChallengeRpc, 0, 0).metadata);
      expect(metadata).not.toHaveProperty('external_provider_usage_key');
      expect(M.createSession.mock.calls[0]?.[3]).toMatchObject({
        reauth_proven_amr: ['external_idp'],
        reauth_proven_at: T0 - 1000,
      });
    });

    it('refuses an account that cannot be loaded, recording the attempt', async () => {
      M.consumeAuthState.mockResolvedValue(sso({ attemptInteractionId: 'int-1' }));
      M.findById.mockResolvedValue(null);
      const response = await callback();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(M.createSession).not.toHaveBeenCalled();
      expect(M.getSessionStore).not.toHaveBeenCalled();
    });

    it('refuses a sign-in the Flow does not allow for this provider', async () => {
      M.consumeAuthState.mockResolvedValue(sso({ attemptInteractionId: 'int-1' }));
      M.sessionProfile.mockResolvedValue({ allowed: false });
      const response = await callback();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(M.createSession).not.toHaveBeenCalled();
      expect(M.scheduleFailure.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'method_disabled' });
    });

    it('survives a failing provider-session index', async () => {
      M.consumeAuthState.mockResolvedValue(sso());
      M.registerProviderSession.mockRejectedValue(new Error('do down'));
      expect((await callback()).status).toBe(302);
    });
  });
});
