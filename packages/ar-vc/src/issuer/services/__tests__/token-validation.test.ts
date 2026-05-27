import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeCNonce,
  getOrCreateCNonce,
  validateProofOfPossession,
  validateVCIAccessToken,
} from '../token-validation';
import type { Env } from '../../../types';

function createKeyManagerEnv(jwks: { keys: unknown[] }): {
  bindings: Pick<Env, 'KEY_MANAGER'>;
  mocks: { idFromName: ReturnType<typeof vi.fn> };
} {
  const idFromName = vi.fn((name: string) => name);
  return {
    bindings: {
      KEY_MANAGER: {
        idFromName,
        get: vi.fn(() => ({
          fetch: vi.fn(async () => Response.json(jwks)),
        })),
      } as unknown as Env['KEY_MANAGER'],
    },
    mocks: { idFromName },
  };
}

function createKV(initialValues: Record<string, string> = {}): {
  namespace: KVNamespace;
  values: Map<string, string>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  const values = new Map(Object.entries(initialValues));
  const put = vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
    values.set(key, value);
    return options;
  });
  const deleteMock = vi.fn(async (key: string) => {
    values.delete(key);
  });

  return {
    namespace: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put,
      delete: deleteMock,
    } as unknown as KVNamespace,
    values,
    put,
    delete: deleteMock,
  };
}

async function createProofJwt(
  payload: { aud: string; nonce: string; iat: number },
  headerOverrides: Record<string, unknown> = {}
): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);

  return new SignJWT(payload)
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'openid4vci-proof+jwt',
      jwk: publicJwk,
      ...headerOverrides,
    })
    .sign(privateKey);
}

describe('validateVCIAccessToken', () => {
  it('derives the fallback DID issuer from the expected request tenant', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    const keyManager = createKeyManagerEnv({
      keys: [{ ...publicJwk, alg: 'ES256', kid: 'tenant-acme-key' }],
    });
    const env = {
      ...keyManager.bindings,
      BASE_DOMAIN: 'oidc.example.com',
      NAKED_DOMAIN_AS_ISSUER: 'true',
      PRIMARY_TENANT_ID: 'default',
      DEFAULT_TENANT_ID: 'default',
    } as unknown as Env;

    const token = await new SignJWT({
      iss: 'did:web:acme.oidc.example.com',
      sub: 'user-acme',
      aud: 'did:web:acme.oidc.example.com',
      scope: 'openid credential',
      tenant_id: 'acme',
      credential_configuration_id: 'UniversityDegreeCredential',
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'tenant-acme-key' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const result = await validateVCIAccessToken(env, token, undefined, 'acme');

    expect(result).toMatchObject({
      valid: true,
      userId: 'user-acme',
      tenantId: 'acme',
      vct: 'UniversityDegreeCredential',
    });
    expect(keyManager.mocks.idFromName).toHaveBeenCalledWith('acme-v3');
    expect(keyManager.mocks.idFromName).not.toHaveBeenCalledWith('default-v3');
  });
});

describe('validateProofOfPossession', () => {
  it('accepts a signed JWT proof with the expected nonce and audience', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await createProofJwt({
      aud: 'did:web:issuer.example.com',
      nonce: 'nonce-123',
      iat: now,
    });

    const result = await validateProofOfPossession(
      {
        POP_VALIDITY_SECONDS: '300',
        POP_CLOCK_SKEW_SECONDS: '60',
      } as unknown as Env,
      { proof_type: 'jwt', jwt },
      'nonce-123',
      'did:web:issuer.example.com'
    );

    expect(result.valid).toBe(true);
    expect(result.holderPublicKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
  });

  it('rejects proof JWTs with the wrong typ header before signature verification', async () => {
    const jwt = await createProofJwt(
      {
        aud: 'did:web:issuer.example.com',
        nonce: 'nonce-123',
        iat: Math.floor(Date.now() / 1000),
      },
      { typ: 'JWT' }
    );

    const result = await validateProofOfPossession(
      {} as Env,
      { proof_type: 'jwt', jwt },
      'nonce-123',
      'did:web:issuer.example.com'
    );

    expect(result).toEqual({ valid: false, error: 'Invalid typ header' });
  });

  it('rejects proofs with mismatched nonce or audience', async () => {
    const jwt = await createProofJwt({
      aud: 'did:web:issuer.example.com',
      nonce: 'nonce-123',
      iat: Math.floor(Date.now() / 1000),
    });

    await expect(
      validateProofOfPossession(
        {} as Env,
        { proof_type: 'jwt', jwt },
        'other-nonce',
        'did:web:issuer.example.com'
      )
    ).resolves.toEqual({ valid: false, error: 'Invalid nonce' });

    await expect(
      validateProofOfPossession(
        {} as Env,
        { proof_type: 'jwt', jwt },
        'nonce-123',
        'did:web:other.example.com'
      )
    ).resolves.toEqual({ valid: false, error: 'Invalid audience' });
  });

  it('rejects stale and future-issued proofs using configured windows', async () => {
    const now = Math.floor(Date.now() / 1000);
    const env = {
      POP_VALIDITY_SECONDS: '120',
      POP_CLOCK_SKEW_SECONDS: '10',
    } as unknown as Env;

    const staleJwt = await createProofJwt({
      aud: 'did:web:issuer.example.com',
      nonce: 'nonce-123',
      iat: now - 121,
    });
    const futureJwt = await createProofJwt({
      aud: 'did:web:issuer.example.com',
      nonce: 'nonce-123',
      iat: now + 11,
    });

    await expect(
      validateProofOfPossession(
        env,
        { proof_type: 'jwt', jwt: staleJwt },
        'nonce-123',
        'did:web:issuer.example.com'
      )
    ).resolves.toEqual({ valid: false, error: 'Proof expired' });

    await expect(
      validateProofOfPossession(
        env,
        { proof_type: 'jwt', jwt: futureJwt },
        'nonce-123',
        'did:web:issuer.example.com'
      )
    ).resolves.toEqual({ valid: false, error: 'Proof issued in the future' });
  });
});

describe('c_nonce helpers', () => {
  it('reuses an existing c_nonce without extending storage', async () => {
    const kv = createKV({ 'cnonce:user-123': 'existing-nonce' });
    const result = await getOrCreateCNonce(
      {
        AUTHRIM_CONFIG: kv.namespace,
        C_NONCE_EXPIRY_SECONDS: '600',
      } as unknown as Env,
      'user-123'
    );

    expect(result).toEqual({ nonce: 'existing-nonce', expiresIn: 600 });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('falls back to the default expiry when c_nonce env is invalid', async () => {
    const kv = createKV();
    const result = await getOrCreateCNonce(
      {
        AUTHRIM_CONFIG: kv.namespace,
        C_NONCE_EXPIRY_SECONDS: 'not-a-number',
      } as unknown as Env,
      'user-123'
    );

    expect(result.expiresIn).toBe(300);
    expect(kv.put).toHaveBeenCalledWith('cnonce:user-123', result.nonce, {
      expirationTtl: 300,
    });
  });

  it('consumes matching c_nonce values only once', async () => {
    const kv = createKV({ 'cnonce:user-123': 'nonce-123' });
    const env = { AUTHRIM_CONFIG: kv.namespace } as unknown as Env;

    await expect(consumeCNonce(env, 'user-123', 'wrong-nonce')).resolves.toBe(false);
    expect(kv.delete).not.toHaveBeenCalled();

    await expect(consumeCNonce(env, 'user-123', 'nonce-123')).resolves.toBe(true);
    expect(kv.delete).toHaveBeenCalledWith('cnonce:user-123');
  });
});
