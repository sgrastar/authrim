import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';

const mocks = vi.hoisted(() => ({
  introspect: vi.fn(),
  getClientCached: vi.fn(),
  encryptJWT: vi.fn(),
  isEncryptionRequired: vi.fn(),
  getClientPublicKey: vi.fn(),
  validateJWEOptions: vi.fn(),
  findByLegacyUserId: vi.fn(),
  applyMapping: vi.fn(),
  resolveAccountData: vi.fn(),
  findConsentRevocation: vi.fn(),
  scheduleFailure: vi.fn(),
  readLifecycle: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    introspectTokenFromContext: mocks.introspect,
    getClientCached: mocks.getClientCached,
    encryptJWT: mocks.encryptJWT,
    isUserInfoEncryptionRequired: mocks.isEncryptionRequired,
    getClientPublicKey: mocks.getClientPublicKey,
    validateJWEOptions: mocks.validateJWEOptions,
    CanonicalRuntimeUserProjectionRepository: class {
      findByLegacyUserId = mocks.findByLegacyUserId;
    },
    resolveEffectiveSettings: async () => ({}),
    applyOIDCIdentityMapping: mocks.applyMapping,
    resolveAccountDataContextFromHono: mocks.resolveAccountData,
    findOAuthClientConsentRevocation: mocks.findConsentRevocation,
    createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    createPIIContextFromHono: () => ({ coreAdapter: {}, defaultPiiAdapter: {} }),
  };
});

vi.mock('@authrim/ar-lib-core/services/identity-mapping-failures', async () => {
  const actual = await vi.importActual<
    typeof import('@authrim/ar-lib-core/services/identity-mapping-failures')
  >('@authrim/ar-lib-core/services/identity-mapping-failures');
  return { ...actual, scheduleIdentityMappingFailure: mocks.scheduleFailure };
});

vi.mock('../account-lifecycle', () => ({
  ACCOUNT_LIFECYCLE_CLAIM: 'authrim_account_lifecycle',
  readAccountLifecycleClaim: mocks.readLifecycle,
}));

import { userinfoHandler } from '../userinfo';
import { OIDCIdentityMappingRuntimeError } from '@authrim/ar-lib-core';
import {
  headerValue,
  lastJson,
  recordingContext,
  type RecordingContext,
} from './helpers/userinfo-context';

const INVALID = { error: 'invalid_token', error_description: 'The access token is invalid' };

function projection() {
  return {
    id: 'user-1',
    tenant_id: 'default',
    subject_id: 'subject:user-1',
    account_id: 'account:user-1',
    email: 'user@example.com',
    email_verified: 1,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
    phone_number: null,
    phone_number_verified: 0,
    address_json: null,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };
}

function claims(extra: Record<string, unknown> = {}) {
  return {
    sub: 'user-1',
    scope: 'openid profile',
    client_id: 'client-1',
    authrim_release: ['*'],
    ...extra,
  };
}

function signIn(tokenClaims: Record<string, unknown> = claims()) {
  mocks.introspect.mockResolvedValue({ valid: true, claims: tokenClaims });
}

function expectNoStore(ctx: RecordingContext) {
  expect(ctx.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(ctx.header).toHaveBeenCalledWith('Pragma', 'no-cache');
}

describe('userinfoHandler error answers (exact headers and bodies)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn();
    mocks.getClientCached.mockResolvedValue({ client_id: 'client-1' });
    mocks.findByLegacyUserId.mockResolvedValue(projection());
    mocks.applyMapping.mockImplementation(async (input: { claims: unknown }) => ({
      claims: input.claims,
    }));
    mocks.resolveAccountData.mockResolvedValue(undefined);
    mocks.findConsentRevocation.mockResolvedValue({ generation: 0, revokedAt: null });
    mocks.isEncryptionRequired.mockReturnValue(false);
    mocks.readLifecycle.mockResolvedValue(undefined);
  });

  describe('account data route', () => {
    it('answers an unknown account route as an invalid token', async () => {
      mocks.resolveAccountData.mockRejectedValue(new Error('account_data_route_not_found'));
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({ body: INVALID, status: 401 });
      expectNoStore(ctx);
      expect(headerValue(ctx, 'WWW-Authenticate')).toBe('Bearer error="invalid_token"');
      expect(ctx.logger.warn).toHaveBeenCalledWith('UserInfo account route resolution failed', {
        error: 'account_data_route_not_found',
      });
    });

    it('answers any other route failure as temporarily unavailable', async () => {
      mocks.resolveAccountData.mockRejectedValue(new Error('route table down'));
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({
        body: { error: 'temporarily_unavailable', error_description: 'User data is unavailable' },
        status: 503,
      });
      expectNoStore(ctx);
      expect(headerValue(ctx, 'WWW-Authenticate')).toBeUndefined();
    });

    it('names a non-Error route failure as account_data_route_unavailable', async () => {
      mocks.resolveAccountData.mockRejectedValue('boom');
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx).status).toBe(503);
      expect(ctx.logger.warn).toHaveBeenCalledWith('UserInfo account route resolution failed', {
        error: 'account_data_route_unavailable',
      });
    });
  });

  describe('consent withdrawal', () => {
    it('answers an unreadable withdrawal state as unavailable', async () => {
      signIn(claims({ authrim_consent_generation: 1 }));
      mocks.findConsentRevocation.mockRejectedValue(new Error('db down'));
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({
        body: {
          error: 'temporarily_unavailable',
          error_description: 'Consent state is unavailable',
        },
        status: 503,
      });
      expectNoStore(ctx);
    });

    it('answers a withdrawn consent as an invalid token', async () => {
      signIn(claims({ authrim_consent_generation: 1 }));
      mocks.findConsentRevocation.mockResolvedValue({ generation: 2, revokedAt: 1 });
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({ body: INVALID, status: 401 });
      expectNoStore(ctx);
      expect(headerValue(ctx, 'WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    });
  });

  describe('client of the token', () => {
    it('does not look a client up for a token without client_id', async () => {
      signIn({ sub: 'user-1', scope: 'openid profile' });
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({ body: INVALID, status: 401 });
      expect(mocks.getClientCached).not.toHaveBeenCalled();
    });

    it('answers a token whose client is gone as an invalid token', async () => {
      mocks.getClientCached.mockResolvedValue(null);
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({ body: INVALID, status: 401 });
    });

    it('answers a pairwise client token that lacks the account reference as invalid', async () => {
      signIn(claims({ token_use: 'access_token', jti: 'jti-1' }));
      mocks.getClientCached.mockResolvedValue({ client_id: 'client-1', subject_type: 'pairwise' });
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({ body: INVALID, status: 401 });
      expect(mocks.applyMapping).not.toHaveBeenCalled();
    });

    it('answers an unknown account as an invalid token', async () => {
      mocks.findByLegacyUserId.mockResolvedValue(null);
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({ body: INVALID, status: 401 });
    });
  });

  describe('claims request integrity', () => {
    const asc = JSON.stringify({
      userinfo: { '::age_over_18': { value: true }, email: null },
    });

    it('applies Authrim-specific claims requests only when the request was integrity protected', async () => {
      mocks.getClientCached.mockResolvedValue({
        client_id: 'client-1',
        claims_parameter_policy: { '::age_over_18': 'claims_allowed', email: 'claims_allowed' },
      });
      mocks.findByLegacyUserId.mockResolvedValue({ ...projection(), birthdate: '2000-01-01' });

      signIn(claims({ scope: 'openid', claims: asc, claims_request_protected: true }));
      const protectedCtx = recordingContext();
      await userinfoHandler(protectedCtx.c);
      expect(lastJson(protectedCtx).body['::age_over_18']).toBe(true);

      signIn(claims({ scope: 'openid', claims: asc }));
      const plainCtx = recordingContext();
      await userinfoHandler(plainCtx.c);
      expect(lastJson(plainCtx).status).toBe(200);
      expect(lastJson(plainCtx).body).toMatchObject({ sub: expect.any(String) as unknown });
      expect(lastJson(plainCtx).body).not.toHaveProperty('::age_over_18');
    });
  });

  describe('identity mapping failures', () => {
    it('records an unexpected mapping error as mapping_failed and answers 500', async () => {
      mocks.applyMapping.mockRejectedValue(new Error('salt unavailable'));
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({
        body: { error: 'server_error', error_description: 'Failed to apply identity mapping' },
        status: 500,
      });
      expect(mocks.scheduleFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'default',
          clientId: 'client-1',
          failure: expect.objectContaining({ code: 'mapping_failed' }) as unknown,
        })
      );
    });

    it('records the code of a mapping runtime error and answers 400', async () => {
      mocks.applyMapping.mockRejectedValue(
        new OIDCIdentityMappingRuntimeError('no salt', { code: 'salt_unavailable' })
      );
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({
        body: {
          error: 'invalid_client_metadata',
          error_description: 'Client identity mapping configuration is invalid',
        },
        status: 400,
      });
      expect(mocks.scheduleFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          failure: expect.objectContaining({ code: 'salt_unavailable' }) as unknown,
        })
      );
    });

    it('still answers when the failure accounting itself throws', async () => {
      mocks.applyMapping.mockRejectedValue(new Error('x'));
      mocks.scheduleFailure.mockImplementation(() => {
        throw new Error('accounting down');
      });
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx).status).toBe(500);
    });
  });

  describe('account lifecycle claim', () => {
    const lifecycle = {
      registration_state: 'registered',
      status: 'active',
      created_at: 1793491200,
      deletion_due_at: null,
      upgrade_eligible: false,
      profile_complete: true,
    };

    it('adds the lifecycle claim when one is read', async () => {
      signIn(claims({ scope: 'openid account:lifecycle:read' }));
      mocks.readLifecycle.mockResolvedValue(lifecycle);
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx).body.authrim_account_lifecycle).toEqual(lifecycle);
      expect(mocks.readLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'default', clientId: 'client-1', user: projection() })
      );
    });

    it('adds nothing when no lifecycle claim is read, and drops one a mapping produced', async () => {
      mocks.applyMapping.mockImplementation(async (input: { claims: Record<string, unknown> }) => ({
        claims: { ...input.claims, authrim_account_lifecycle: { forged: true } },
      }));
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx).body).not.toHaveProperty('authrim_account_lifecycle');
    });

    it('answers a deleted account as an invalid token', async () => {
      mocks.readLifecycle.mockRejectedValue(new Error('account_lifecycle_deleted'));
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({ body: INVALID, status: 401 });
      expectNoStore(ctx);
      expect(headerValue(ctx, 'WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    });

    it.each([[new Error('something else')], ['account_lifecycle_deleted']])(
      'answers another failure (%s) as temporarily unavailable',
      async (failure) => {
        mocks.readLifecycle.mockRejectedValue(failure);
        const ctx = recordingContext();
        await userinfoHandler(ctx.c);
        expect(lastJson(ctx)).toEqual({
          body: { error: 'temporarily_unavailable', error_description: 'User data is unavailable' },
          status: 503,
        });
        expectNoStore(ctx);
        expect(headerValue(ctx, 'WWW-Authenticate')).toBeUndefined();
      }
    );
  });

  describe('release approval', () => {
    it('answers a missing approval with consent_required and no-store headers', async () => {
      signIn(claims({ authrim_release: undefined }));
      const ctx = recordingContext();
      await userinfoHandler(ctx.c);
      expect(lastJson(ctx)).toEqual({
        body: {
          error: 'consent_required',
          error_description: 'User consent is required before releasing UserInfo claims',
        },
        status: 403,
      });
      expectNoStore(ctx);
    });
  });

  it('answers plain JSON claims with no-store headers', async () => {
    signIn(claims({ scope: 'openid' }));
    const ctx = recordingContext();
    await userinfoHandler(ctx.c);
    expect(lastJson(ctx)).toEqual({ body: { sub: 'user-1' }, status: 200 });
    expectNoStore(ctx);
  });
});

describe('userinfoHandler signed and encrypted answers', () => {
  async function signingKeys() {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    return exportPKCS8(privateKey);
  }

  function envWithKeys(
    keyManager: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      KEY_MANAGER: {
        idFromName: vi.fn().mockReturnValue('km-id'),
        get: vi.fn().mockReturnValue(keyManager),
      },
      ...extra,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    signIn(claims({ scope: 'openid' }));
    mocks.findByLegacyUserId.mockResolvedValue(projection());
    mocks.applyMapping.mockImplementation(async (input: { claims: unknown }) => ({
      claims: input.claims,
    }));
    mocks.resolveAccountData.mockResolvedValue(undefined);
    mocks.findConsentRevocation.mockResolvedValue({ generation: 0, revokedAt: null });
    mocks.readLifecycle.mockResolvedValue(undefined);
    mocks.isEncryptionRequired.mockReturnValue(false);
  });

  it('signs with typ JWT and answers application/jwt with no-store headers', async () => {
    const privatePEM = await signingKeys();
    mocks.getClientCached.mockResolvedValue({
      client_id: 'client-1',
      userinfo_signed_response_alg: 'RS256',
    });
    const ctx = recordingContext({
      env: envWithKeys({ getActiveKeyWithPrivateRpc: async () => ({ kid: 'sk', privatePEM }) }),
      tenantId: 'tenant-headers',
    });
    await userinfoHandler(ctx.c);
    const jwt = String((ctx.body.mock.calls.at(-1) as [string])[0]);
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'sk' });
    expect(headerValue(ctx, 'Content-Type')).toBe('application/jwt');
    expectNoStore(ctx);
  });

  it('answers 500 when the key manager has no private key', async () => {
    mocks.getClientCached.mockResolvedValue({
      client_id: 'client-1',
      userinfo_signed_response_alg: 'RS256',
    });
    const ctx = recordingContext({
      env: envWithKeys({ getActiveKeyWithPrivateRpc: async () => ({ kid: 'sk' }) }),
      tenantId: 'tenant-nokey',
    });
    await userinfoHandler(ctx.c);
    expect(lastJson(ctx)).toEqual({
      body: { error: 'server_error', error_description: 'Failed to sign UserInfo response' },
      status: 500,
    });
  });

  it('answers 400 for a client whose UserInfo signing algorithm is unsupported', async () => {
    mocks.getClientCached.mockResolvedValue({
      client_id: 'client-1',
      userinfo_signed_response_alg: 'HS256',
    });
    const ctx = recordingContext({ tenantId: 'tenant-badalg' });
    await userinfoHandler(ctx.c);
    expect(lastJson(ctx)).toEqual({
      body: {
        error: 'invalid_client_metadata',
        error_description: 'Client UserInfo signing configuration is invalid',
      },
      status: 400,
    });
  });

  describe('signing key cache', () => {
    async function signOnce(options: {
      tenantId: string;
      privatePEM: string;
      getKey: ReturnType<typeof vi.fn>;
      configGet?: ReturnType<typeof vi.fn>;
    }) {
      mocks.getClientCached.mockResolvedValue({
        client_id: 'client-1',
        userinfo_signed_response_alg: 'RS256',
      });
      const idFromName = vi.fn().mockReturnValue('km-id');
      const ctx = recordingContext({
        tenantId: options.tenantId,
        env: {
          KEY_MANAGER: {
            idFromName,
            get: vi.fn().mockReturnValue({ getActiveKeyWithPrivateRpc: options.getKey }),
          },
          ...(options.configGet ? { AUTHRIM_CONFIG: { get: options.configGet } } : {}),
        },
      });
      await userinfoHandler(ctx.c);
      expect(ctx.body).toHaveBeenCalledTimes(1);
      const jwt = String((ctx.body.mock.calls.at(-1) as [string])[0]);
      expect(jwt.split('.')).toHaveLength(3);
      return { ctx, idFromName };
    }

    it('names the key manager instance and the version key after the tenant', async () => {
      const privatePEM = await signingKeys();
      const getKey = vi.fn().mockResolvedValue({ kid: 'k1', privatePEM });
      const configGet = vi.fn().mockResolvedValue('v1');
      const { idFromName } = await signOnce({
        tenantId: 'tenant-names',
        privatePEM,
        getKey,
        configGet,
      });
      expect(idFromName).toHaveBeenCalledWith('tenant-names-v3');
      expect(configGet).toHaveBeenCalledWith('v1:key-version:tenant-names');
    });

    it('keeps one cache entry per tenant', async () => {
      const privatePEM = await signingKeys();
      const getKey = vi.fn().mockResolvedValue({ kid: 'k1', privatePEM });
      await signOnce({ tenantId: 'tenant-one', privatePEM, getKey });
      await signOnce({ tenantId: 'tenant-two', privatePEM, getKey });
      expect(getKey).toHaveBeenCalledTimes(2);
      await signOnce({ tenantId: 'tenant-one', privatePEM, getKey });
      expect(getKey).toHaveBeenCalledTimes(2);
    });

    it('treats an unreadable version signal as no version and keeps using the cached key', async () => {
      const privatePEM = await signingKeys();
      const getKey = vi.fn().mockResolvedValue({ kid: 'k1', privatePEM });
      const configGet = vi.fn().mockRejectedValue(new Error('kv down'));
      const first = await signOnce({ tenantId: 'tenant-kvdown', privatePEM, getKey, configGet });
      expect(first.ctx.body).toHaveBeenCalled();
      await signOnce({ tenantId: 'tenant-kvdown', privatePEM, getKey, configGet });
      expect(getKey).toHaveBeenCalledTimes(1);
    });

    it('refreshes the key exactly when the cache is 60 seconds old', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
        const privatePEM = await signingKeys();
        const getKey = vi.fn().mockResolvedValue({ kid: 'k1', privatePEM });
        await signOnce({ tenantId: 'tenant-ttl', privatePEM, getKey });
        vi.setSystemTime(new Date('2026-11-01T00:00:59.999Z'));
        await signOnce({ tenantId: 'tenant-ttl', privatePEM, getKey });
        expect(getKey).toHaveBeenCalledTimes(1);
        vi.setSystemTime(new Date('2026-11-01T00:01:00.000Z'));
        await signOnce({ tenantId: 'tenant-ttl', privatePEM, getKey });
        expect(getKey).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('encrypted answers', () => {
    function requireEncryption(extra: Record<string, unknown> = {}) {
      mocks.getClientCached.mockResolvedValue({
        client_id: 'client-1',
        userinfo_encrypted_response_alg: 'RSA-OAEP',
        userinfo_encrypted_response_enc: 'A256GCM',
        ...extra,
      });
      mocks.isEncryptionRequired.mockReturnValue(true);
      mocks.getClientPublicKey.mockResolvedValue({ kid: 'client-key', kty: 'RSA' });
      mocks.encryptJWT.mockResolvedValue('encrypted.jwt.token');
    }

    it('signs with typ JWT, then answers the JWE as application/jwt with no-store headers', async () => {
      const privatePEM = await signingKeys();
      requireEncryption();
      const ctx = recordingContext({
        env: envWithKeys({ getActiveKeyWithPrivateRpc: async () => ({ kid: 'sk', privatePEM }) }),
        tenantId: 'tenant-enc',
      });
      await userinfoHandler(ctx.c);
      const signed = String(mocks.encryptJWT.mock.calls[0]?.[0]);
      expect(decodeProtectedHeader(signed)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'sk' });
      expect(ctx.body).toHaveBeenCalledWith('encrypted.jwt.token');
      expect(headerValue(ctx, 'Content-Type')).toBe('application/jwt');
      expectNoStore(ctx);
    });
  });
});
