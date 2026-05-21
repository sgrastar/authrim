import { describe, expect, it, vi } from 'vitest';
import { hashClientSecret, type Env, type OAuthClient } from '@authrim/ar-lib-core';
import ingestApp from '../routes/diagnostic-logging/ingest';

class MockR2Bucket {
  readonly store = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async get(key: string): Promise<{ text: () => Promise<string> } | null> {
    const value = this.store.get(key);
    return value === undefined ? null : { text: async () => value };
  }

  async list(): Promise<{ objects: Array<{ key: string }>; truncated: boolean }> {
    return {
      objects: Array.from(this.store.keys()).map((key) => ({ key })),
      truncated: false,
    };
  }
}

function createClient(overrides: Partial<OAuthClient> = {}): OAuthClient {
  const now = Date.now();
  return {
    client_id: 'diag-client',
    client_secret_hash: null,
    client_name: 'Diagnostic Client',
    description: null,
    tenant_id: 'tenant-1',
    application_type: 'web',
    trust_group: null,
    trust_group_id: null,
    browser_public_client_mode: null,
    browser_refresh_token_policy: 'disabled',
    native_sso_enabled: null,
    native_channel_allowed: null,
    allowed_channels: null,
    device_secret_revoke_enabled: null,
    device_secret_revoke_trust_groups: null,
    device_secret_introspection_enabled: null,
    device_secret_introspection_trust_groups: null,
    redirect_uris: '[]',
    grant_types: '["authorization_code"]',
    response_types: '["code"]',
    scope: null,
    logo_uri: null,
    client_uri: null,
    policy_uri: null,
    tos_uri: null,
    contacts: null,
    post_logout_redirect_uris: null,
    subject_type: 'public',
    sector_identifier_uri: null,
    token_endpoint_auth_method: 'client_secret_post',
    jwks: null,
    jwks_uri: null,
    is_trusted: false,
    skip_consent: false,
    allow_claims_without_scope: false,
    claims_parameter_policy: null,
    asc_enabled: true,
    asc_protected_request_required: true,
    asc_sao_enabled: true,
    asc_transformed_claims_enabled: true,
    asc_allowed_transformed_claims: null,
    token_exchange_allowed: false,
    allowed_subject_token_clients: null,
    allowed_token_exchange_resources: null,
    delegation_mode: 'delegation',
    client_credentials_allowed: false,
    allowed_scopes: null,
    default_scope: null,
    default_audience: null,
    default_resource: null,
    backchannel_token_delivery_mode: null,
    backchannel_client_notification_endpoint: null,
    backchannel_authentication_request_signing_alg: null,
    backchannel_user_code_parameter: false,
    userinfo_signed_response_alg: null,
    backchannel_logout_uri: null,
    backchannel_logout_session_required: false,
    frontchannel_logout_uri: null,
    frontchannel_logout_session_required: false,
    allowed_redirect_origins: null,
    software_id: null,
    software_version: null,
    requestable_scopes: null,
    require_pkce: true,
    initiate_login_uri: null,
    login_ui_url: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createAdapter(client: OAuthClient | null) {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM oauth_clients') && params?.[1] === 'diag-client') {
        return client;
      }
      return null;
    }),
    execute: vi.fn(async () => ({ rowsAffected: 0 })),
    batch: vi.fn(async () => []),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
    isHealthy: vi.fn(async () => ({ healthy: true })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => undefined),
  };
}

function createEnv(client: OAuthClient | null, bucket: MockR2Bucket): Env {
  return {
    ISSUER_URL: 'https://issuer.example.com',
    OTP_HMAC_SECRET: 'otp-secret',
    DB: createAdapter(client),
    DIAGNOSTIC_LOGS: bucket as unknown as R2Bucket,
  } as unknown as Env;
}

describe('diagnostic logging ingest', () => {
  it('rejects confidential clients when client_secret does not match stored hash', async () => {
    const bucket = new MockR2Bucket();
    const client = createClient({
      client_secret_hash: await hashClientSecret('correct-secret'),
    });
    const env = createEnv(client, bucket);

    const response = await ingestApp.request(
      '/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'tenant-1',
          client_id: 'diag-client',
          client_secret: 'wrong-secret',
          logs: [
            {
              id: 'log-1',
              tenantId: 'tenant-1',
              clientId: 'diag-client',
              category: 'auth-decision',
              level: 'info',
              timestamp: Date.now(),
              decision: 'allow',
              reason: 'test',
            },
          ],
        }),
      },
      env
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'invalid_client_secret',
    });
    expect(bucket.store.size).toBe(0);
  });
});
