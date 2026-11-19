/**
 * Native SSO token exchange fixtures for the mut-nativesso-* tests (over mut-nativesso-harness).
 */
import { createMockContext } from './mocks';
import { createConfidentialClient, type TestClientMetadata } from './fixtures';
import type { Harness, HarnessMocks } from './mut-nativesso-harness';

export const DEVICE_SECRET_TOKEN_TYPE = 'urn:openid:params:token-type:device-secret';
export const NATIVE_CLIENT_ID = 'native-client-001';
export const ISSUER = 'https://auth.example.com';

export type NativeSSOErrorBody = {
  error?: string;
  error_description?: string;
  error_details?: {
    code?: string;
    retryable?: boolean;
    severity?: string;
    user_action?: string;
  };
  access_token?: string;
};

export function deviceSecretEntity(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'ds-001',
    user_id: 'user-001',
    session_id: 'sid-001',
    device_platform: 'ios',
    last_used_at: now * 1000,
    use_count: 0,
    ...overrides,
  };
}

/** A confidential client allowed Native SSO, a valid ID token, device secret and DPoP proof. */
export function setupNativeSSO(
  mocks: HarnessMocks,
  harness: Harness,
  payloadOverrides: Record<string, unknown> = {},
  clientOverrides: Partial<TestClientMetadata> = {}
): TestClientMetadata {
  const client = createConfidentialClient({
    client_id: NATIVE_CLIENT_ID,
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['urn:ietf:params:oauth:grant-type:token-exchange'],
    token_exchange_allowed: true,
    native_sso_enabled: true,
    allowed_scopes: ['openid', 'profile'],
    ...clientOverrides,
  });
  const now = Math.floor(Date.now() / 1000);
  harness.setSystemSettings({
    oidc: { tokenExchange: { enabled: true, allowedSubjectTokenTypes: ['id_token'] } },
  });
  mocks.mockLoadTenantProfileCached.mockResolvedValue({
    tenant_id: 'default',
    allows_token_exchange: true,
    allows_refresh_token: true,
    max_token_ttl_seconds: 3600,
  });
  mocks.mockGetClientCached.mockResolvedValue(client);
  mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
  mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
    ok: true,
    entity: deviceSecretEntity(),
  });
  mocks.mockParseToken.mockReturnValue({
    iss: ISSUER,
    sub: 'user-001',
    aud: client.client_id,
    exp: now + 3600,
    ds_hash: 'presented-ds-hash',
    authrim_subject_account: true,
    scope: 'openid profile',
    ...payloadOverrides,
  });
  mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'test-kid-001' });
  mocks.mockCalculateDsHash.mockResolvedValue('presented-ds-hash');
  mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
  mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'native-jkt' });
  return client;
}

export function nativeSSOContext(
  harness: Harness,
  overrides: Record<string, string | undefined> = {},
  headers: Record<string, string> = {}
) {
  const body: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: NATIVE_CLIENT_ID,
    client_secret: 'valid-secret',
    subject_token: 'subject-id-token',
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    actor_token: 'presented-device-secret',
    actor_token_type: DEVICE_SECRET_TOKEN_TYPE,
    scope: 'openid profile',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete body[key];
    else body[key] = value;
  }
  return createMockContext({ body, env: harness.mockEnv, headers });
}

/** Assurance settings the token endpoint reads, over the other categories as configured. */
export function useAssuranceSettings(mocks: HarnessMocks, values: Record<string, unknown>): void {
  const base = mocks.mockResolveEffectiveSettings.getMockImplementation();
  mocks.mockResolveEffectiveSettings.mockImplementation(
    async (env: unknown, category: string, ...rest: unknown[]) =>
      category === 'assurance'
        ? values
        : (base as (...args: unknown[]) => unknown)(env, category, ...rest)
  );
}

/** The response headers the handler set on the context (c.header). */
export function contextHeader(ctx: ReturnType<typeof createMockContext>, name: string) {
  return (ctx as unknown as { res: { headers: Map<string, string> } }).res.headers.get(name);
}
