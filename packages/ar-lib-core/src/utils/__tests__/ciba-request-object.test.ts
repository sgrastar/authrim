import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { validateCIBARequestObject } from '../ciba';

describe('CIBA signed authentication request', () => {
  it('accepts a PS256 request with the required FAPI CIBA claims', async () => {
    const { privateKey, publicKey } = await generateKeyPair('PS256');
    const publicJwk = { ...(await exportJWK(publicKey)), alg: 'PS256', kid: 'client-key' };
    const now = Math.floor(Date.now() / 1000);
    const request = await new SignJWT({
      scope: 'openid profile',
      login_hint: 'user@example.com',
    })
      .setProtectedHeader({ alg: 'PS256', kid: 'client-key' })
      .setIssuer('client-1')
      .setAudience('https://issuer.example')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 300)
      .setJti('request-1')
      .sign(privateKey);

    const result = await validateCIBARequestObject(request, {
      clientId: 'client-1',
      audience: 'https://issuer.example',
      algorithm: 'PS256',
      jwks: { keys: [publicJwk] },
    });
    expect(result.valid).toBe(true);
    expect(result.payload?.login_hint).toBe('user@example.com');
  });

  it('rejects algorithm substitution and missing required claims', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'client-key' };
    const now = Math.floor(Date.now() / 1000);
    const request = await new SignJWT({ scope: 'openid', login_hint: 'user@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'client-key' })
      .setIssuer('client-1')
      .setAudience('https://issuer.example')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);

    await expect(
      validateCIBARequestObject(request, {
        clientId: 'client-1',
        audience: 'https://issuer.example',
        algorithm: 'PS256',
        jwks: { keys: [publicJwk] },
      })
    ).resolves.toMatchObject({ valid: false });
  });
});
