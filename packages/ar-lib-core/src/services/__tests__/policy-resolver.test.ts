import { describe, expect, it, vi } from 'vitest';
import { PolicyResolverService } from '../policy-resolver';

function tenant(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a',
    version: 2,
    oauth: {
      maxAccessTokenExpiry: 3600,
      maxRefreshTokenExpiry: 86400,
      maxIdTokenExpiry: 3600,
      maxAuthCodeTtl: 600,
      allowedIdTokenSigningAlgs: ['RS256'],
      allowedResponseTypes: ['code'],
      pkceRequirement: 'required',
      parRequirement: 'recommended',
      jarmEnabled: true,
      refreshTokenRotation: true,
      refreshIdTokenReissue: false,
    },
    encryption: {
      allowedSigningAlgorithms: ['RS256'],
      allowedKeyEncryptionAlgorithms: ['RSA-OAEP'],
      allowedContentEncryptionAlgorithms: ['A256GCM'],
      piiEncryptionRequired: true,
    },
    session: {
      maxSessionAge: 86400,
      idleTimeout: 3600,
      maxConcurrentSessions: 5,
      slidingSessionEnabled: true,
    },
    consent: { maxRememberDuration: 86400 },
    authMethods: {
      passkey: 'required',
      emailCode: 'enabled',
      password: 'disabled',
      externalIdp: 'enabled',
      did: 'disabled',
    },
    security: {
      tier: 'high',
      mfa: {
        requirement: 'required',
        allowedMethods: ['totp', 'passkey'],
        rememberDurationMax: 3600,
      },
    },
    scopes: {
      allowedScopes: ['openid', 'profile', 'email'],
      forbiddenScopes: ['admin'],
    },
    rateLimit: { loginAttemptsPerMinute: 10, tokenRequestsPerMinute: 100 },
    ...overrides,
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'client-1',
    version: 3,
    tenantContractVersion: 2,
    oauth: {
      accessTokenExpiry: 7200,
      refreshTokenExpiry: 172800,
      idTokenExpiry: 7200,
      authCodeTtl: 1200,
      idTokenSigningAlg: 'ES256',
      allowedResponseTypes: ['code', 'token'],
      allowedGrantTypes: ['authorization_code'],
      pkceRequired: false,
      parRequired: false,
      refreshTokenRotation: undefined,
      refreshIdTokenReissue: true,
    },
    encryption: {
      keyEncryptionAlg: 'RSA-OAEP',
      contentEncryptionAlg: 'A256GCM',
      encryptIdToken: true,
      encryptUserInfo: false,
    },
    consent: {
      policy: 'explicit',
      rememberDuration: 172800,
      implicitScopes: ['openid'],
      allowGranularConsent: true,
    },
    authMethods: {
      passkey: true,
      emailCode: true,
      password: true,
      externalIdp: true,
      did: true,
      preferredMethod: 'passkey',
      allowedExternalIdpIds: ['google'],
    },
    scopes: {
      allowedScopes: ['openid', 'profile', 'admin', 'unknown'],
      defaultScopes: ['openid', 'admin'],
      allowDynamicScopes: false,
    },
    clientType: { type: 'public', isFirstParty: true },
    metadata: { notes: 'Example client' },
    ...overrides,
  };
}

describe('PolicyResolverService', () => {
  it('resolves tenant constraints over client preferences with warnings and debug evidence', async () => {
    const result = await new PolicyResolverService().resolve(tenant() as never, client() as never, {
      includeDebug: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.policy).toMatchObject({
      tenantId: 'tenant-a',
      clientId: 'client-1',
      oauth: {
        accessTokenExpiry: 3600,
        refreshTokenExpiry: 86400,
        idTokenExpiry: 3600,
        authCodeTtl: 600,
        idTokenSigningAlg: 'RS256',
        allowedResponseTypes: ['code'],
        pkceRequired: true,
        parRequired: false,
        refreshTokenRotation: true,
        refreshIdTokenReissue: true,
      },
      encryption: {
        signingAlgorithm: 'RS256',
        keyEncryptionAlg: 'RSA-OAEP',
        contentEncryptionAlg: 'A256GCM',
        piiEncryptionRequired: true,
      },
      consent: { rememberDuration: 86400, isFirstParty: true },
      authMethods: { passkey: true, password: false, did: false },
      mfa: { required: true, conditional: false, canRemember: true },
      scopes: { available: ['openid', 'profile'], default: ['openid'] },
      security: { tier: 'high', clientType: 'public' },
      clientInfo: { applicationType: 'spa', displayName: 'Example client' },
    });
    expect(result.warnings?.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['OAUTH_EXPIRY_CAPPED', 'SCOPES_FILTERED'])
    );
    expect(result.debug).toMatchObject({ cacheHit: false });
    expect(result.debug?.steps).toHaveLength(10);
  });

  it('rejects clients that reference a newer tenant contract', async () => {
    const result = await new PolicyResolverService().resolve(
      tenant({ version: 1 }) as never,
      client({ tenantContractVersion: 2 }) as never
    );
    expect(result).toMatchObject({ success: false, error: { code: 'CNTR001' } });
  });

  it('serves cached policy unless force refresh is requested', async () => {
    const cachedPolicy = { tenantId: 'tenant-a', clientId: 'client-1' };
    const cache = {
      get: vi.fn().mockResolvedValue(cachedPolicy),
      put: vi.fn(),
    };
    const resolver = new PolicyResolverService(cache as never, 30);
    const hit = await resolver.resolve(tenant() as never, client() as never, {
      includeDebug: true,
    });
    expect(hit).toMatchObject({
      success: true,
      policy: cachedPolicy,
      debug: { cacheHit: true, cacheKey: expect.stringContaining('tenant-a') },
    });
    expect(cache.put).not.toHaveBeenCalled();

    await resolver.resolve(tenant() as never, client() as never, { forceRefresh: true });
    expect(cache.put).toHaveBeenCalledWith(
      expect.stringContaining('tenant-a'),
      expect.any(String),
      { expirationTtl: 30 }
    );
  });

  it('recovers from cache read failures and reports resolution exceptions', async () => {
    const cache = { get: vi.fn().mockRejectedValue(new Error('KV down')), put: vi.fn() };
    await expect(
      new PolicyResolverService(cache as never).resolve(tenant() as never, client() as never)
    ).resolves.toMatchObject({
      success: true,
    });
    const broken = client({ oauth: null });
    await expect(
      new PolicyResolverService().resolve(tenant() as never, broken as never)
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'CNTR020' },
    });
  });

  it('builds flow designer choices from effective policy', async () => {
    const resolved = await new PolicyResolverService().resolve(
      tenant() as never,
      client() as never
    );
    if (!resolved.success) throw new Error('expected success');
    const options = await new PolicyResolverService().getAvailableOptions(resolved.policy);
    expect(options.availableAuthMethods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'passkey', available: true, required: true, priority: 1 }),
        expect.objectContaining({ id: 'password', available: false }),
      ])
    );
    expect(options.requiredNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'mfa' })])
    );
    expect(options.forbiddenNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'capability.password' })])
    );
    expect(options.availableScopes.map((scope) => scope.name)).toEqual(['openid', 'profile']);
  });

  it('validates violations against tenant constraints', async () => {
    const result = await new PolicyResolverService().validateClientAgainstTenant(
      tenant() as never,
      client() as never
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.validatedFields).toEqual(expect.arrayContaining(['oauth.accessTokenExpiry']));
  });

  it('handles permissive branches and validates an empty flow result', async () => {
    const permissiveTenant = tenant({
      oauth: {
        ...(tenant().oauth as object),
        pkceRequirement: 'optional',
        parRequirement: 'optional',
      },
      authMethods: {
        passkey: 'disabled',
        emailCode: 'disabled',
        password: 'enabled',
        externalIdp: 'disabled',
        did: 'enabled',
      },
      security: {
        tier: 'standard',
        mfa: { requirement: 'conditional', allowedMethods: [], rememberDurationMax: 0 },
      },
    });
    const permissiveClient = client({
      oauth: {
        ...(client().oauth as object),
        accessTokenExpiry: 100,
        idTokenSigningAlg: 'RS256',
        pkceRequired: false,
      },
      encryption: { encryptIdToken: false, encryptUserInfo: false },
      authMethods: {
        passkey: false,
        emailCode: false,
        password: true,
        externalIdp: false,
        did: true,
        preferredMethod: 'password',
        allowedExternalIdpIds: [],
      },
      clientType: { type: 'confidential', isFirstParty: false },
    });
    const result = await new PolicyResolverService().resolve(
      permissiveTenant as never,
      permissiveClient as never
    );
    expect(result).toMatchObject({
      success: true,
      policy: {
        oauth: { pkceRequired: false, parRequired: false },
        mfa: { required: false, conditional: true, canRemember: false },
        clientInfo: { applicationType: 'web', isFirstParty: false },
      },
    });
    if (!result.success) throw new Error('expected success');
    await expect(
      new PolicyResolverService().validateFlowAgainstPolicy(result.policy, 'flow')
    ).resolves.toEqual({
      valid: true,
      violations: [],
      warnings: [],
    });
  });
});
