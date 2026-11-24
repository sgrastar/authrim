/**
 * OIDCRPClient ID token validation with the real jose: signature, expiry boundary, issuer,
 * audience and nonce on actually signed tokens and a fixed clock.
 */
import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn<(url: string) => Promise<Response>>() }));

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({
    module: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  validateWebhookUrl: (value: string) => ({ valid: value.startsWith('https://') }),
  safeFetch: (url: string) => mocks.fetch(url),
  safeFetchJson: async (url: string) => (await mocks.fetch(url)).json(),
  readResponseTextWithLimit: async (response: Response) => response.text(),
}));

import { OIDCRPClient } from '../clients/oidc-client';

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const NOW_S = Math.floor(T0 / 1000);
const ISSUER = 'https://op.example';

let signing: Awaited<ReturnType<typeof jose.generateKeyPair>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  signing = await jose.generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await jose.exportJWK(signing.publicKey)), kid: 'k1', alg: 'ES256' };
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ keys: [jwk] })));
});
afterEach(() => vi.useRealTimers());

const client = (extra: Record<string, unknown> = {}) =>
  new OIDCRPClient({
    issuer: ISSUER,
    clientId: 'client-1',
    clientSecret: 's',
    redirectUri: 'https://rp.example/cb',
    scopes: ['openid'],
    jwksUri: `${ISSUER}/jwks`,
    ...extra,
  });

const token = (
  claims: Record<string, unknown> = {},
  options: { exp?: number; iss?: string; aud?: string | string[]; key?: CryptoKey } = {}
) =>
  new jose.SignJWT({ sub: 'user-1', nonce: 'no', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? 'client-1')
    .setIssuedAt(NOW_S - 10)
    .setExpirationTime(options.exp ?? NOW_S + 300)
    .sign(options.key ?? signing.privateKey);

const validate = (jwt: string, c = client()) => c.validateIdToken(jwt, { nonce: 'no' });

describe('a signed ID token', () => {
  it('is accepted with its claims', async () => {
    expect(await validate(await token({ email: 'a@example.com' }))).toMatchObject({
      sub: 'user-1',
      email: 'a@example.com',
      iss: ISSUER,
      aud: 'client-1',
    });
  });

  it('expires at its exp: one second ahead is valid, exactly now is not', async () => {
    expect(await validate(await token({}, { exp: NOW_S + 1 }))).toBeTruthy();
    await expect(validate(await token({}, { exp: NOW_S }))).rejects.toThrow();
    await expect(validate(await token({}, { exp: NOW_S - 1 }))).rejects.toThrow();
  });

  it('is refused for another issuer, audience, nonce or key', async () => {
    await expect(validate(await token({}, { iss: 'https://evil.example' }))).rejects.toThrow();
    await expect(validate(await token({}, { aud: 'other-client' }))).rejects.toThrow();
    await expect(validate(await token({ nonce: 'replayed' }))).rejects.toThrow(
      'ID token nonce mismatch'
    );
    const other = await jose.generateKeyPair('ES256', { extractable: true });
    await expect(validate(await token({}, { key: other.privateKey }))).rejects.toThrow();
  });

  it('is refused with an audience that is not trusted, and accepted when trusted', async () => {
    const jwt = await token({}, { aud: ['client-1', 'other'] });
    await expect(validate(jwt)).rejects.toThrow(
      'ID token audience contains an audience that is not trusted'
    );
    expect(await validate(jwt, client({ trustedAudiences: ['other'] }))).toBeTruthy();
  });

  it('is refused without a sub', async () => {
    await expect(validate(await token({ sub: '' }))).rejects.toThrow(
      'ID token missing required sub claim'
    );
  });
});
