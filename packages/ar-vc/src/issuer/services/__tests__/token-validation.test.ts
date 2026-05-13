import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { validateVCIAccessToken } from '../token-validation';
import type { Env } from '../../../types';

function createKeyManagerEnv(jwks: { keys: unknown[] }): Pick<Env, 'KEY_MANAGER'> {
  return {
    KEY_MANAGER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => Response.json(jwks)),
      })),
    } as unknown as Env['KEY_MANAGER'],
  };
}

describe('validateVCIAccessToken', () => {
  it('derives the fallback DID issuer from the expected request tenant', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    const env = {
      ...createKeyManagerEnv({
        keys: [{ ...publicJwk, alg: 'ES256', kid: 'tenant-acme-key' }],
      }),
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
    expect(env.KEY_MANAGER.idFromName).toHaveBeenCalledWith('acme-v3');
    expect(env.KEY_MANAGER.idFromName).not.toHaveBeenCalledWith('default-v3');
  });
});
