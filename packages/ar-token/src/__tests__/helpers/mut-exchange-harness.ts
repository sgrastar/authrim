/**
 * Shared harness for the mut-exchange-* Token Exchange tests.
 *
 * Usage in a test file (the factory imports this module, so the mocks below are the ones the
 * handler sees, and the test imports the same instance):
 *
 *   vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
 *     const h = await import('./helpers/mut-exchange-harness');
 *     return h.mockCore(await importOriginal());
 *   });
 *   vi.mock('../external-id-jag-verifier', async () =>
 *     (await import('./helpers/mut-exchange-harness')).mockJagVerifier());
 *
 * This module never imports '@authrim/ar-lib-core' at runtime (only through vi.importActual).
 */
import { expect, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createMockContext, createMockDurableObjectNamespace } from './mocks';
import type { MockEnv } from './mocks';

type CoreModule = typeof import('@authrim/ar-lib-core');
type Fn = ReturnType<typeof vi.fn>;

const silentLogger = () => ({
  module: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
});

export const m = {
  getLogger: vi.fn(silentLogger),
  createLogger: vi.fn(silentLogger),
  getClientCached: vi.fn(),
  loadTenantProfileCached: vi.fn(),
  protocolSettings: vi.fn(),
  validateClientAssertion: vi.fn(),
  verifyClientSecretHash: vi.fn(),
  parseToken: vi.fn(),
  parseTokenHeader: vi.fn(),
  verifyToken: vi.fn(),
  isTokenRevoked: vi.fn(),
  generateRegionAwareJti: vi.fn(),
  createAccessToken: vi.fn(),
  extractDPoPProof: vi.fn(),
  validateDPoPProof: vi.fn(),
  validateClientCertificateBinding: vi.fn(),
  getPresentedClientCertificateThumbprint: vi.fn(),
  resolveAppSecurityRequirements: vi.fn(),
  requireDedicatedAdminDatabaseAdapter: vi.fn(),
  resolveElevationGrantSubjectToken: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
  readAccountAuthenticationState: vi.fn(),
  findOAuthClientConsentRevocation: vi.fn(),
  publishEvent: vi.fn(),
  verifyExternalIdJag: vi.fn(),
  accountAdapter: { query: vi.fn() },
  /** When set, the sub another app is given for a user (deriveIssuedSubject). */
  derivedSubject: { value: undefined as string | undefined },
};

/** Per-category Settings API values layered over env + catalog defaults. */
export const settingsOverrides: Record<string, Record<string, unknown>> = {};

export function mockCore(actual: CoreModule): CoreModule {
  // Env + catalog defaults, as the Settings API resolves them at platform level (built from the
  // real module passed in: importing anything that loads the mocked module here would deadlock).
  const platformSettings = async (env: unknown, category: string) => {
    const manager = actual.createSettingsManager({
      env: (env ?? {}) as Record<string, string | undefined>,
      kv: null,
      cacheTTL: 0,
    });
    for (const meta of Object.values(actual.ALL_CATEGORY_META)) manager.registerCategory(meta);
    return (await manager.getAll(category, { type: 'platform' })).values;
  };
  return {
    ...actual,
    getLogger: m.getLogger,
    createLogger: m.createLogger,
    getClientCached: m.getClientCached,
    loadTenantProfileCached: m.loadTenantProfileCached,
    getProtocolSettingsCached: async (...args: unknown[]) => ({
      fapi: {},
      oidc: {},
      security: {},
      ...(((await m.protocolSettings(...args)) as Record<string, unknown> | null) ?? {}),
    }),
    resolveEffectiveSettings: async (env: unknown, category: string) => {
      if (category === 'oauth') {
        return {
          'oauth.access_token_expiry': 3600,
          'oauth.refresh_token_expiry': 86400,
          ...settingsOverrides.oauth,
        };
      }
      const override = settingsOverrides[category];
      if (override && override.__throw === true) throw new Error(`${category} unavailable`);
      return { ...(await platformSettings(env, category)), ...override };
    },
    deriveIssuedSubject: (...args: Parameters<CoreModule['deriveIssuedSubject']>) =>
      m.derivedSubject.value
        ? Promise.resolve({ ok: true as const, sub: m.derivedSubject.value })
        : actual.deriveIssuedSubject(...args),
    validateClientAssertion: m.validateClientAssertion,
    verifyClientSecretHash: m.verifyClientSecretHash,
    parseToken: m.parseToken,
    parseTokenHeader: m.parseTokenHeader,
    verifyToken: m.verifyToken,
    isTokenRevoked: m.isTokenRevoked,
    generateRegionAwareJti: m.generateRegionAwareJti,
    createAccessToken: m.createAccessToken,
    extractDPoPProof: m.extractDPoPProof,
    validateDPoPProof: m.validateDPoPProof,
    validateClientCertificateBinding: m.validateClientCertificateBinding,
    getPresentedClientCertificateThumbprint: m.getPresentedClientCertificateThumbprint,
    resolveAppSecurityRequirements: m.resolveAppSecurityRequirements,
    requireDedicatedAdminDatabaseAdapter: m.requireDedicatedAdminDatabaseAdapter,
    resolveElevationGrantSubjectToken: m.resolveElevationGrantSubjectToken,
    resolveAccountDataContextFromHono: m.resolveAccountDataContextFromHono,
    createAccountAuthContextFromHono: () => ({ coreAdapter: m.accountAdapter }),
    readAccountAuthenticationState: m.readAccountAuthenticationState,
    findOAuthClientConsentRevocation: m.findOAuthClientConsentRevocation,
    publishEvent: m.publishEvent,
  } as unknown as CoreModule;
}

export function mockJagVerifier() {
  return { verifyExternalIdJagSubjectToken: m.verifyExternalIdJag };
}

export const SERVICE_CLIENT = 'service-client-1';
export const ISSUER = 'https://auth.example.com';
export const TARGET = 'https://service.example.com';
export const AT_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

export function baseClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: SERVICE_CLIENT,
    tenant_id: 'default',
    client_secret_hash: 'hashed-secret',
    token_exchange_allowed: true,
    token_endpoint_auth_method: 'client_secret_post',
    delegation_mode: 'delegation',
    allowed_scopes: ['openid', 'profile', 'email'],
    allowed_token_exchange_resources: [TARGET, 'https://other.example.com'],
    allowed_subject_token_clients: [],
    ...overrides,
  };
}

/** A user's access token issued to the requesting client (verified, unexpired, unbound). */
export function userSubject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'user-1',
    client_id: SERVICE_CLIENT,
    aud: [SERVICE_CLIENT],
    token_use: 'access',
    jti: 'subject-jti-1',
    scope: 'openid profile',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

/** A client-credentials token of the requesting client (names no account). */
export function clientSubject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return userSubject({ sub: `client:${SERVICE_CLIENT}`, ...overrides });
}

type KeySet = Awaited<ReturnType<CoreModule['generateKeySet']>>;
const keySets = new Map<string, Promise<KeySet>>();

/** A real RSA key set (cached per kid). */
export async function keySet(kid: string): Promise<KeySet> {
  let existing = keySets.get(kid);
  if (!existing) {
    existing = vi
      .importActual<CoreModule>('@authrim/ar-lib-core')
      .then((actual) => actual.generateKeySet(kid));
    keySets.set(kid, existing);
  }
  return existing;
}

/** Verification and signing keys (PUBLIC_JWK_JSON and the KeyManager both hold `kid`), and the
 * KeyManager's active signing key read. */
export async function keyEnvParts(kid = 'kid-main') {
  const keys = await keySet(kid);
  const getActiveKey = vi.fn().mockResolvedValue({ kid, privatePEM: keys.privatePEM });
  const env = {
    KEY_MANAGER: createMockDurableObjectNamespace({
      rpcMethods: {
        getActiveKeyWithPrivateRpc: getActiveKey,
        getAllPublicKeysRpc: vi.fn().mockResolvedValue([keys.publicJWK]),
      },
    }),
    PUBLIC_JWK_JSON: JSON.stringify(keys.publicJWK),
  };
  return { env, getActiveKey };
}

export async function keyEnv(kid = 'kid-main'): Promise<Partial<MockEnv>> {
  return (await keyEnvParts(kid)).env;
}

/** The KV the request's env reads the key version from. */
export function configKv(context: Context<{ Bindings: Env }>): MockEnv['AUTHRIM_CONFIG'] {
  return (context.env as unknown as MockEnv).AUTHRIM_CONFIG;
}

/** The RSA modulus of a verification key, to tell which key a token was verified with. */
export async function modulusOf(key: unknown): Promise<string | undefined> {
  const jwk = (await crypto.subtle.exportKey('jwk', key as CryptoKey)) as JsonWebKey;
  return jwk.n;
}

export const baseEnv: Record<string, unknown> = {
  ENABLE_TOKEN_EXCHANGE: 'true',
  ENABLE_TOKEN_EXCHANGE_DELEGATION: 'true',
  ENABLE_TOKEN_EXCHANGE_IMPERSONATION: 'true',
};

export function exchangeContext(
  body: Record<string, unknown> = {},
  options: {
    env?: Partial<MockEnv> | Record<string, unknown>;
    headers?: Record<string, string>;
    url?: string;
  } = {}
): Context<{ Bindings: Env }> {
  const merged: Record<string, unknown> = {
    grant_type: EXCHANGE_GRANT,
    subject_token: 'subject-token',
    subject_token_type: AT_TYPE,
    client_id: SERVICE_CLIENT,
    client_secret: 'top-secret',
    audience: TARGET,
    ...body,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return createMockContext({
    method: 'POST',
    body: merged as Record<string, string>,
    headers: options.headers,
    url: options.url,
    env: { ...baseEnv, ...options.env },
  });
}

/** Restore every mock to a working exchange of `userSubject()` by `baseClient()`. */
export function resetExchange(): void {
  for (const value of Object.values(m)) {
    if (typeof value === 'function') (value as Fn).mockReset();
  }
  m.accountAdapter.query.mockReset().mockResolvedValue([]);
  m.derivedSubject.value = undefined;
  for (const key of Object.keys(settingsOverrides)) delete settingsOverrides[key];
  m.getLogger.mockImplementation(silentLogger);
  m.createLogger.mockImplementation(silentLogger);
  m.getClientCached.mockImplementation(async (_c: unknown, _e: unknown, id: string) =>
    id === SERVICE_CLIENT ? baseClient() : null
  );
  m.loadTenantProfileCached.mockResolvedValue({
    allows_token_exchange: true,
    max_token_ttl_seconds: 3600,
  });
  m.protocolSettings.mockResolvedValue(null);
  m.validateClientAssertion.mockResolvedValue({ valid: true });
  m.verifyClientSecretHash.mockResolvedValue(true);
  m.parseToken.mockReturnValue(userSubject());
  m.parseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'kid-main' });
  m.verifyToken.mockResolvedValue({});
  m.isTokenRevoked.mockResolvedValue(false);
  m.generateRegionAwareJti.mockResolvedValue({ jti: 'region-jti-1' });
  m.createAccessToken.mockResolvedValue({ token: 'exchanged-access-token', jti: 'at-jti-1' });
  m.extractDPoPProof.mockReturnValue(null);
  m.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'dpop-jkt' });
  m.validateClientCertificateBinding.mockResolvedValue({ valid: false });
  m.getPresentedClientCertificateThumbprint.mockResolvedValue(undefined);
  m.resolveAppSecurityRequirements.mockResolvedValue({
    pkceRequired: false,
    httpsRedirectOnly: true,
    dpopBoundAccessTokens: false,
    requireEncryptedRequestObject: false,
  });
  m.requireDedicatedAdminDatabaseAdapter.mockReturnValue({});
  m.resolveAccountDataContextFromHono.mockResolvedValue({});
  m.readAccountAuthenticationState.mockResolvedValue({ lifecycle: null });
  m.findOAuthClientConsentRevocation.mockResolvedValue({ generation: 0, revokedAt: null });
  m.publishEvent.mockResolvedValue(undefined);
}

/** The claims the exchanged access token was created with. */
export function issuedClaims(): Record<string, unknown> {
  expect(m.createAccessToken).toHaveBeenCalledTimes(1);
  return m.createAccessToken.mock.calls[0][0] as Record<string, unknown>;
}

export async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json<Record<string, unknown>>();
}

/** Assert an OAuth error response (status, code and description) and that no token was minted. */
export async function expectError(
  response: Response,
  status: number,
  error: string,
  description: string
): Promise<void> {
  expect(response.status).toBe(status);
  expect(await body(response)).toEqual({ error, error_description: description });
  expect(m.createAccessToken).not.toHaveBeenCalled();
}
