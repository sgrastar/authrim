/**
 * Client Credentials fixtures for the mut-clientcreds-* tests (over mut-nativesso-harness).
 */
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createMockContext, parseJsonResponse } from './mocks';
import { createM2MClient, type TestClientMetadata } from './fixtures';
import type { Harness, HarnessMocks } from './mut-nativesso-harness';

export const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const CLIENT_ID = 'm2m-service-client-001';

/** An M2M client (client_secret_post) found only by its own id, in a tenant allowing the grant. */
export function setupM2MClient(
  mocks: HarnessMocks,
  overrides: Partial<TestClientMetadata> = {}
): TestClientMetadata {
  const client = createM2MClient({
    token_endpoint_auth_method: 'client_secret_post',
    ...overrides,
  });
  mocks.mockGetClientCached.mockImplementation(async (_c, _env, clientId: string) =>
    clientId === client.client_id ? client : null
  );
  mocks.mockLoadTenantProfileCached.mockResolvedValue({
    tenant_id: client.tenant_id ?? 'default',
    max_token_ttl_seconds: 1800,
    allows_client_credentials: true,
  });
  return client;
}

export async function requestClientCredentials(
  harness: Harness,
  handler: (c: Context<{ Bindings: Env }>) => Promise<Response>,
  overrides: Record<string, string | undefined> = {},
  options: { env?: Record<string, unknown>; headers?: Record<string, string> } = {}
) {
  const body: Record<string, string> = {
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: 'valid-m2m-secret',
    scope: 'api:read',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete body[key];
    else body[key] = value;
  }
  const ctx = createMockContext({
    body,
    headers: options.headers,
    env: { ...harness.mockEnv, ENABLE_CLIENT_CREDENTIALS: 'true', ...options.env },
  });
  const response = await handler(ctx);
  return { ctx, response, body: await parseJsonResponse<Record<string, unknown>>(response) };
}

export const ADMIN_CLIENT_ID = 'setup-tool';
export const ADMIN_KID = 'setup-2026-05';

/**
 * A DB_ADMIN machine principal (amp_setup) with one ES256 credential (amk_setup). `row` changes
 * both reads of it; `snapshot` only the later, single-snapshot read of the grant.
 */
export function mockAdminMachineAccess(
  mocks: HarnessMocks,
  row: Record<string, unknown> = {},
  snapshot: Record<string, unknown> = {}
): void {
  const base = {
    id: 'amp_setup',
    client_id: ADMIN_CLIENT_ID,
    display_name: 'Authrim Setup Tool',
    description: null,
    principal_type: 'setup_tool',
    status: 'active',
    default_audience: 'authrim:admin-api',
    token_ttl_seconds: 600,
    created_by_actor_type: 'bootstrap',
    created_by_actor_id: 'setup',
    created_at: 1,
    updated_at: 1,
    disabled_at: null,
    disabled_by_actor_type: null,
    disabled_by_actor_id: null,
    credential_id: 'amk_setup',
    credential_principal_id: 'amp_setup',
    credential_kid: ADMIN_KID,
    credential_public_jwk_json: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
    credential_alg: 'ES256',
    credential_display_name: 'Setup key',
    credential_description: null,
    credential_status: 'active',
    credential_not_before: null,
    credential_expires_at: null,
    credential_last_used_at: null,
    credential_last_used_ip: null,
    credential_last_used_user_agent: null,
    credential_created_by_actor_type: 'bootstrap',
    credential_created_by_actor_id: 'setup',
    credential_created_at: 1,
    credential_updated_at: 1,
    credential_revoked_at: null,
    credential_revoked_by_actor_type: null,
    credential_revoked_by_actor_id: null,
    credential_revoke_reason: null,
    principal_permissions_json: JSON.stringify(['admin:tenants.read', 'admin:clients.create']),
    credential_permissions_json: JSON.stringify([]),
    principal_scopes_json: JSON.stringify([{ scope_mode: 'allow', tenant_id: 'default' }]),
    credential_scopes_json: JSON.stringify([]),
    ...row,
  };
  mocks.mockAdminAdapter.queryOne.mockImplementation(async (sql: string) => {
    if (!sql.includes('JOIN admin_machine_credentials')) return null;
    return sql.includes('principal_permissions_json') ? { ...base, ...snapshot } : base;
  });
}

/** The assertion's claims and header for parseToken / parseTokenHeader. */
export function useAdminAssertion(
  mocks: HarnessMocks,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {}
): void {
  const now = Math.floor(Date.now() / 1000);
  mocks.mockParseToken.mockReturnValue({
    iss: ADMIN_CLIENT_ID,
    sub: ADMIN_CLIENT_ID,
    aud: 'https://auth.example.com/token',
    iat: now,
    exp: now + 60,
    jti: 'assertion-1',
    ...claims,
  });
  mocks.mockParseTokenHeader.mockReturnValue({ alg: 'ES256', kid: ADMIN_KID, ...header });
  mocks.mockValidateClientAssertion.mockResolvedValue({ valid: true, client_id: ADMIN_CLIENT_ID });
}

export const ADMIN_REQUEST = {
  client_id: ADMIN_CLIENT_ID,
  client_secret: undefined,
  client_assertion_type: JWT_BEARER,
  client_assertion: 'header.payload.signature',
  audience: 'authrim:admin-api',
  scope: 'admin:tenants.read',
};
