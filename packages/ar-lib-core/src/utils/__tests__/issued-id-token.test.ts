import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { importIssuedTokenKey } from '../issued-id-token';
import { validateIdTokenHint } from '../logout-validation';

async function signedWith(algorithm: 'RS256' | 'ES256' | 'PS256', kid: string) {
  const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: algorithm, use: 'sig' };
  const token = await new SignJWT({ sub: 'user-1', aud: 'client-1' })
    .setProtectedHeader({ alg: algorithm, kid })
    .setIssuer('https://op.example.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { jwk, token };
}

describe('keys of ID tokens this tenant issued', () => {
  it('finds the key of each algorithm Authrim signs ID tokens with', async () => {
    const keys = await Promise.all([
      signedWith('RS256', 'rs'),
      signedWith('ES256', 'es'),
      signedWith('PS256', 'ps'),
    ]);
    for (const { token } of keys) {
      const { algorithm } = await importIssuedTokenKey(
        keys.map((key) => key.jwk),
        token
      );
      expect(['RS256', 'ES256', 'PS256']).toContain(algorithm);
    }
  });

  it('refuses another algorithm, or a key of another algorithm under the same kid', async () => {
    const es = await signedWith('ES256', 'shared');
    const rs = await signedWith('RS256', 'shared');
    await expect(importIssuedTokenKey([rs.jwk], es.token)).rejects.toThrow(
      'Key verification failed'
    );
    const unsigned = `${btoa(JSON.stringify({ alg: 'HS256', kid: 'shared' }))}.e30.sig`;
    await expect(importIssuedTokenKey([rs.jwk], unsigned)).rejects.toThrow(
      'Unsupported token signing algorithm'
    );
  });

  it('accepts an id_token_hint signed with ES256 at logout', async () => {
    const { jwk, token } = await signedWith('ES256', 'es-logout');
    const result = await validateIdTokenHint(
      token,
      async () => (await importIssuedTokenKey([jwk], token)).key,
      'https://op.example.com'
    );
    expect(result).toMatchObject({ valid: true, userId: 'user-1' });
  });
});
