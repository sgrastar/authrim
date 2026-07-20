import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';
import { Fapi2Client } from '../clients/fapi2-client';

async function createEcJwk(kid: string): Promise<jose.JWK> {
  const keyPair = await jose.generateKeyPair('ES256', { extractable: true });
  return { ...(await jose.exportJWK(keyPair.privateKey)), kid, alg: 'ES256', use: 'sig' };
}

describe('Fapi2Client', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let client: Fapi2Client;

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    client = new Fapi2Client({
      issuer: 'https://server.example.com',
      clientId: 'fapi-client',
      redirectUri: 'https://client.example.com/callback',
      clientAssertionPrivateJwk: await createEcJwk('client-auth-key'),
      dpopPrivateJwk: await createEcJwk('dpop-key'),
    });
  });

  it('uses separate ES256 keys for client assertions and DPoP proofs', async () => {
    const assertion = await client.createClientAssertion(
      'https://server.example.com/token',
      1_700_000_000
    );
    const proof = await client.createDpopProof({
      url: 'https://server.example.com/resource?ignored=true',
      method: 'GET',
      accessToken: 'opaque-access-token',
      now: 1_700_000_000,
    });

    expect(jose.decodeProtectedHeader(assertion)).toMatchObject({
      alg: 'ES256',
      typ: 'JWT',
      kid: 'client-auth-key',
    });
    expect(jose.decodeJwt(assertion)).toMatchObject({
      iss: 'fapi-client',
      sub: 'fapi-client',
      aud: 'https://server.example.com/token',
      iat: 1_700_000_000,
      exp: 1_700_000_060,
    });
    const dpopHeader = jose.decodeProtectedHeader(proof);
    expect(dpopHeader).toMatchObject({ typ: 'dpop+jwt', alg: 'ES256' });
    expect((dpopHeader.jwk as jose.JWK).kid).toBe('dpop-key');
    expect((dpopHeader.jwk as jose.JWK).d).toBeUndefined();
    expect(jose.decodeJwt(proof)).toMatchObject({
      htm: 'GET',
      htu: 'https://server.example.com/resource',
    });
    expect(jose.decodeJwt(proof).ath).toBeTypeOf('string');
  });

  it('creates a short-lived ES256 FAPI authorization request object', async () => {
    const request = await client.createAuthorizationRequestObject(
      {
        response_type: 'code',
        client_id: 'fapi-client',
        redirect_uri: 'https://client.example.com/callback',
        state: 'expected-state',
      },
      1_700_000_000
    );

    expect(jose.decodeProtectedHeader(request)).toMatchObject({
      alg: 'ES256',
      typ: 'oauth-authz-req+jwt',
      kid: 'client-auth-key',
    });
    expect(jose.decodeJwt(request)).toMatchObject({
      iss: 'fapi-client',
      aud: 'https://server.example.com',
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_000_060,
      state: 'expected-state',
    });
  });

  it('validates JARM signature, issuer, exact audience, state and algorithm', async () => {
    const signingKey = await jose.generateKeyPair('ES256', { extractable: true });
    const publicJwk = {
      ...(await jose.exportJWK(signingKey.publicKey)),
      kid: 'server-key',
      alg: 'ES256',
      use: 'sig',
    };
    const responseJwt = await new jose.SignJWT({ state: 'expected-state', code: 'code' })
      .setProtectedHeader({ alg: 'ES256', kid: 'server-key', typ: 'oauth-authz-resp+jwt' })
      .setIssuer('https://server.example.com')
      .setAudience('fapi-client')
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(signingKey.privateKey);

    await expect(
      client.validateJarmResponse({
        responseJwt,
        jwks: { keys: [publicJwk] },
        expectedState: 'expected-state',
        signingAlgorithm: 'ES256',
      })
    ).resolves.toMatchObject({
      iss: 'https://server.example.com',
      state: 'expected-state',
      code: 'code',
    });
    await expect(
      client.validateJarmResponse({
        responseJwt,
        jwks: { keys: [publicJwk] },
        expectedState: 'wrong-state',
        signingAlgorithm: 'ES256',
      })
    ).rejects.toThrow('state mismatch');
  });

  it('rejects a signed JARM response without the required exp claim', async () => {
    const signingKey = await jose.generateKeyPair('ES256', { extractable: true });
    const publicJwk = {
      ...(await jose.exportJWK(signingKey.publicKey)),
      kid: 'server-key',
      alg: 'ES256',
      use: 'sig',
    };
    const responseJwt = await new jose.SignJWT({ state: 'expected-state', code: 'code' })
      .setProtectedHeader({ alg: 'ES256', kid: 'server-key', typ: 'oauth-authz-resp+jwt' })
      .setIssuer('https://server.example.com')
      .setAudience('fapi-client')
      .setIssuedAt()
      .sign(signingKey.privateKey);

    await expect(
      client.validateJarmResponse({
        responseJwt,
        jwks: { keys: [publicJwk] },
        expectedState: 'expected-state',
        signingAlgorithm: 'ES256',
      })
    ).rejects.toThrow('required');
  });

  it('retries a token request once with the server DPoP nonce and a fresh assertion', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'use_dpop_nonce' }), {
          status: 400,
          headers: { 'DPoP-Nonce': 'server-nonce' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            token_type: 'dPoP',
            expires_in: 300,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const result = await client.exchangeCode({
      tokenEndpoint: 'https://server.example.com/token',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
    });

    expect(result.token_type).toBe('dPoP');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]![1] as RequestInit;
    const second = fetchMock.mock.calls[1]![1] as RequestInit;
    const firstHeaders = first.headers as Record<string, string>;
    const secondHeaders = second.headers as Record<string, string>;
    expect(jose.decodeJwt(firstHeaders.DPoP).nonce).toBeUndefined();
    expect(jose.decodeJwt(secondHeaders.DPoP).nonce).toBe('server-nonce');
    const firstAssertion = new URLSearchParams(first.body as string).get('client_assertion')!;
    const secondAssertion = new URLSearchParams(second.body as string).get('client_assertion')!;
    expect(jose.decodeJwt(firstAssertion).aud).toBe('https://server.example.com');
    expect(jose.decodeJwt(firstAssertion).jti).not.toBe(jose.decodeJwt(secondAssertion).jti);
  });

  it('accepts a token response without expires_in', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-token', token_type: 'DPoP' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      client.exchangeCode({
        tokenEndpoint: 'https://server.example.com/token',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
      })
    ).resolves.toMatchObject({ access_token: 'access-token', token_type: 'DPoP' });
  });

  it('requires a valid PAR request_uri and expiry', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ request_uri: 'invalid', expires_in: 90 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      client.pushAuthorizationRequest('https://server.example.com/par', {
        response_type: 'code',
        client_id: 'fapi-client',
      })
    ).rejects.toThrow('PAR response missing valid request_uri');
  });
});
