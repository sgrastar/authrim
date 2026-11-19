/**
 * Authorization code grant: the Native SSO device secret issued with the tokens, and the
 * encrypted ID token (src/token.ts handleAuthorizationCodeGrant).
 */
import {
  mocks,
  resetHarness,
  useCodeStore,
  postClient,
  postToken,
  codeRequest,
  expectOAuthError,
} from './helpers/mut-authcode-harness';
import { describe, it, expect, beforeEach } from 'vitest';
import { exportJWK, generateKeyPair, decodeProtectedHeader } from 'jose';
import { createAuthCodeData, type TestClientMetadata } from './helpers/fixtures';
import type { MockEnv } from './helpers/mocks';

let env: MockEnv;
const nativeClient = postClient({ application_type: 'native' });
const SID = 'session-native-0001';

beforeEach(() => {
  env = resetHarness();
  mocks.getClientCached.mockResolvedValue(nativeClient);
  mocks.isNativeSSOEnabled.mockResolvedValue(true);
});

function entity(id: string) {
  return {
    id,
    tenant_id: 'default',
    client_id: nativeClient.client_id,
    user_id: 'user-001',
    session_id: SID,
    secret_hash: 'h',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    expires_at: 1_702_592_000_000,
    use_count: 0,
    is_active: 1,
  };
}

function secret(id: string, overrides: Record<string, unknown> = {}) {
  return { ...entity(id), session_id: 'other-session', ...overrides };
}

function config(overrides: Record<string, unknown> = {}) {
  mocks.getNativeSSOConfig.mockResolvedValue({
    enabled: true,
    deviceSecretTTLDays: 30,
    maxDeviceSecretsPerUser: 2,
    maxSecretsBehavior: 'revoke_oldest',
    deviceSecretRotationPolicy: 'disabled',
    deviceSecretRotationOverlapSeconds: 0,
    ...overrides,
  });
}

async function exchange(client: TestClientMetadata = nativeClient, scope = 'api:read') {
  const data = createAuthCodeData({ scope, sid: SID });
  useCodeStore(env, data);
  return postToken(env, codeRequest(client, data));
}

describe('Native SSO device secret', () => {
  beforeEach(() => {
    config();
    mocks.deviceSecretRepo.createSecret.mockResolvedValue({
      secret: 'raw-device-secret',
      entity: entity('ds-new'),
    });
  });

  it('issues a device secret with its hash in the ID token', async () => {
    const { response, body } = await exchange();
    expect(response.status).toBe(200);
    expect(body.device_secret).toBe('raw-device-secret');
    expect(body.installation_id).toBe('ds-new');
    expect(mocks.deviceSecretRepo.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-001',
        session_id: SID,
        client_id: nativeClient.client_id,
        ttl_ms: 30 * 24 * 60 * 60 * 1000,
      })
    );
    expect(mocks.calculateDsHash).toHaveBeenCalledWith('raw-device-secret');
    expect(mocks.createIDToken.mock.calls[0][0]).toMatchObject({ ds_hash: 'ds-hash-value' });
    expect(mocks.recordDeviceSecretRouteHint).toHaveBeenCalledWith(env, {
      secret: 'raw-device-secret',
      tenantId: 'default',
      accountId: 'account:user-001',
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_702_592_000_000,
    });
  });

  it('withdraws the secret when its route hint cannot be written', async () => {
    mocks.recordDeviceSecretRouteHint.mockRejectedValue(new Error('kv down'));
    const { response, body } = await exchange();
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('device_secret');
    expect(mocks.deviceSecretRepo.revoke).toHaveBeenCalledWith(
      'ds-new',
      'route_hint_write_failed',
      'default'
    );
    expect(mocks.createIDToken.mock.calls[0][0]).not.toHaveProperty('ds_hash');
  });

  it('issues none for a grant without a refresh token', async () => {
    const { body } = await exchange(nativeClient, 'openid');
    expect(body).not.toHaveProperty('device_secret');
    expect(mocks.deviceSecretRepo.createSecret).not.toHaveBeenCalled();
  });

  it('issues none to a client that is not a native app', async () => {
    const web = postClient();
    mocks.getClientCached.mockResolvedValue(web);
    const { body } = await exchange(web);
    expect(body).not.toHaveProperty('device_secret');
    expect(mocks.deviceSecretRepo.createSecret).not.toHaveBeenCalled();
  });

  it('answers without a secret when its creation is refused', async () => {
    mocks.deviceSecretRepo.createSecret.mockResolvedValue({ ok: false, reason: 'limit_exceeded' });
    const { response, body } = await exchange();
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('device_secret');
    expect(mocks.calculateDsHash).not.toHaveBeenCalled();
  });

  it('revokes the oldest active secrets to stay under the limit', async () => {
    mocks.deviceSecretRepo.findByUserId.mockResolvedValue([
      secret('ds-c', { created_at: 3 }),
      secret('ds-a', { created_at: 1 }),
      secret('ds-inactive', { created_at: 0, is_active: 0 }),
      secret('ds-b', { created_at: 2 }),
    ]);
    await exchange();
    expect(mocks.deviceSecretRepo.revoke.mock.calls).toEqual([
      ['ds-a', 'max_secrets_exceeded', 'default'],
      ['ds-b', 'max_secrets_exceeded', 'default'],
    ]);
    expect(mocks.deviceSecretRepo.createSecret).toHaveBeenCalled();
  });

  it('revokes nothing below the limit', async () => {
    mocks.deviceSecretRepo.findByUserId.mockResolvedValue([secret('ds-a', { created_at: 1 })]);
    await exchange();
    expect(mocks.deviceSecretRepo.revoke).not.toHaveBeenCalled();
    expect(mocks.deviceSecretRepo.createSecret).toHaveBeenCalled();
  });

  it('issues no new secret at the limit in reject mode', async () => {
    config({ maxSecretsBehavior: 'reject' });
    mocks.deviceSecretRepo.findByUserId.mockResolvedValue([secret('ds-a'), secret('ds-b')]);
    const { response, body } = await exchange();
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('device_secret');
    expect(mocks.deviceSecretRepo.revoke).not.toHaveBeenCalled();
    expect(mocks.deviceSecretRepo.createSecret).not.toHaveBeenCalled();
  });

  it('issues a new secret below the limit in reject mode', async () => {
    config({ maxSecretsBehavior: 'reject' });
    mocks.deviceSecretRepo.findByUserId.mockResolvedValue([secret('ds-a')]);
    const { body } = await exchange();
    expect(body.device_secret).toBe('raw-device-secret');
  });

  it('rotates the secrets of the same session out before counting', async () => {
    config({ maxSecretsBehavior: 'reject', deviceSecretRotationPolicy: 'explicit' });
    mocks.deviceSecretRepo.findByUserId.mockResolvedValue([
      secret('ds-same', { session_id: SID }),
      secret('ds-other'),
      secret('ds-same-revoked', { session_id: SID, revoked_at: 1, is_active: 0 }),
    ]);
    const { body } = await exchange();
    expect(mocks.deviceSecretRepo.revoke.mock.calls).toEqual([['ds-same', 'rotation', 'default']]);
    expect(body.device_secret).toBe('raw-device-secret');
  });

  it('does not rotate when rotation keeps an overlap', async () => {
    config({
      maxSecretsBehavior: 'reject',
      deviceSecretRotationPolicy: 'explicit',
      deviceSecretRotationOverlapSeconds: 60,
    });
    mocks.deviceSecretRepo.findByUserId.mockResolvedValue([secret('ds-same', { session_id: SID })]);
    await exchange();
    expect(mocks.deviceSecretRepo.revoke).not.toHaveBeenCalled();
  });

  it('still issues the tokens when the device secret store fails', async () => {
    mocks.deviceSecretRepo.findByUserId.mockRejectedValue(new Error('db down'));
    const { response, body } = await exchange();
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('device_secret');
  });
});

describe('encrypted ID token', () => {
  async function encryptingClient(overrides: Partial<TestClientMetadata> = {}) {
    const { publicKey } = await generateKeyPair('RSA-OAEP-256', { extractable: true });
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'enc-key-1',
      use: 'enc',
      alg: 'RSA-OAEP-256',
    };
    return postClient({
      id_token_encrypted_response_alg: 'RSA-OAEP-256',
      id_token_encrypted_response_enc: 'A256GCM',
      jwks: { keys: [jwk] } as never,
      ...overrides,
    });
  }

  it('encrypts the signed ID token to the client key', async () => {
    const client = await encryptingClient();
    mocks.getClientCached.mockResolvedValue(client);
    const { response, body } = await exchange(client);
    expect(response.status).toBe(200);
    const idToken = body.id_token as string;
    expect(idToken.split('.')).toHaveLength(5);
    expect(decodeProtectedHeader(idToken)).toMatchObject({
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
      cty: 'JWT',
      kid: 'enc-key-1',
    });
  });

  it('refuses an unsupported encryption configuration', async () => {
    const client = await encryptingClient({ id_token_encrypted_response_alg: 'RSA1_5' });
    mocks.getClientCached.mockResolvedValue(client);
    const result = await exchange(client);
    expectOAuthError(
      result,
      400,
      'invalid_client_metadata',
      'Client encryption configuration is invalid'
    );
  });

  it('refuses encryption without a client key', async () => {
    const client = await encryptingClient({ jwks: { keys: [] } });
    mocks.getClientCached.mockResolvedValue(client);
    const result = await exchange(client);
    expectOAuthError(
      result,
      400,
      'invalid_client_metadata',
      'Client requires ID token encryption but no public key (jwks or jwks_uri) is configured'
    );
  });

  it('answers 500 when the ID token cannot be encrypted', async () => {
    const client = postClient({
      id_token_encrypted_response_alg: 'RSA-OAEP-256',
      id_token_encrypted_response_enc: 'A256GCM',
      jwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'broken', use: 'enc' }] } as never,
    });
    mocks.getClientCached.mockResolvedValue(client);
    const result = await exchange(client);
    expectOAuthError(result, 500, 'server_error', 'Failed to encrypt ID token');
  });
});
