import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { JWK } from 'jose';
import {
  AUDIENCE,
  EMAIL,
  ISSUER,
  JWKS_URL,
  NONCE,
  NOW,
  OK,
  createPresentation,
  createProviderFetch,
  fail,
  fixture,
  loadFixtures,
  verify,
} from './helpers/mut-factor-evp-fixtures';
import { verifyEmailVerificationProtocol } from '../email-verification-protocol';

beforeAll(loadFixtures);

const RECORD = '_email-verification.example.com';
const question = (extra: Record<string, unknown> = {}) => ({
  name: `${RECORD}.`,
  type: 16,
  ...extra,
});
const answer = (data: string, extra: Record<string, unknown> = {}) => ({
  name: `${RECORD}.`,
  type: 16,
  TTL: 60,
  data,
  ...extra,
});
const doh = (extra: Record<string, unknown> = {}) => ({
  Status: 0,
  TC: false,
  Question: [question()],
  Answer: [answer('"iss=issuer.example"')],
  ...extra,
});

/** Verifies through the built-in DoH lookup, the resolver answering `dns`. */
async function viaDoh(dns: unknown, provider = createProviderFetch(fixture().issuerJwk)) {
  const token = await createPresentation();
  const fetchJson = vi.fn(async (url: string, options?: unknown) =>
    url.startsWith('https://cloudflare-dns.com/')
      ? typeof dns === 'function'
        ? (dns as () => unknown)()
        : dns
      : provider(url, options as never)
  );
  const result = await verifyEmailVerificationProtocol({
    presentationToken: token,
    expectedEmail: EMAIL,
    expectedNonce: NONCE,
    expectedAudience: AUDIENCE,
    nowSeconds: NOW,
    fetchJson,
  });
  return { result, fetchJson };
}

describe('email verification protocol: DNS over HTTPS', () => {
  it('asks for the TXT record with DNSSEC data as DNS JSON', async () => {
    const { result, fetchJson } = await viaDoh(doh());
    expect(result).toEqual(OK);
    const url = new URL(fetchJson.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://cloudflare-dns.com/dns-query');
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: RECORD, type: 'TXT', do: 'true' });
    expect(fetchJson.mock.calls[0][1]).toEqual({
      method: 'GET',
      headers: { Accept: 'application/dns-json' },
      redirect: 'error',
      requireHttps: true,
      allowLocalhost: false,
      timeoutMs: 5000,
      maxResponseSize: 65536,
    });
    expect(fetchJson.mock.calls[1][1]).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  });

  it.each([
    ['not an object', 'answer'],
    ['a failed status', doh({ Status: 2 })],
    ['no TC flag', doh({ TC: undefined })],
    ['no question list', doh({ Question: undefined })],
    ['two questions', doh({ Question: [question(), question()] })],
    ['a question that is not an object', doh({ Question: ['q'] })],
    ['a question of another type', doh({ Question: [question({ type: 1 })] })],
    ['a question without a name', doh({ Question: [question({ name: 5 })] })],
    ['a question for another name', doh({ Question: [question({ name: 'other.example.' })] })],
    ['no answer', doh({ Answer: undefined })],
    ['an answer that is not a list', doh({ Answer: {} })],
    ['an answer that is not an object', doh({ Answer: ['a'] })],
    ['an answer without a name', doh({ Answer: [answer('"iss=issuer.example"', { name: 1 })] })],
    ['an answer without a type', doh({ Answer: [answer('"iss=issuer.example"', { type: '16' })] })],
    ['an answer without data', doh({ Answer: [answer('"iss=issuer.example"', { data: 3 })] })],
    ['an unquoted TXT value', doh({ Answer: [answer('iss=issuer.example')] })],
    ['an unclosed TXT value', doh({ Answer: [answer('"iss=issuer.example')] })],
    ['a dangling escape', doh({ Answer: [answer('"iss=issuer.example\\')] })],
    ['an escape above 255', doh({ Answer: [answer('"iss=issuer\\256example"')] })],
    ['a blank TXT value', doh({ Answer: [answer('   ')] })],
    ['text after a chunk', doh({ Answer: [answer('"iss=issuer.example" x')] })],
    [
      'only other records',
      doh({ Answer: [answer('"x"', { type: 5 }), answer('"y"', { name: 'b.' })] }),
    ],
  ])('fails discovery for %s', async (_label, dns) => {
    const { result } = await viaDoh(dns);
    expect(result).toEqual(fail('issuer_discovery_failed'));
  });

  it('decodes chunks and escapes and skips other records', async () => {
    const { result } = await viaDoh(
      doh({
        Question: [question({ name: '_EMAIL-verification.Example.com' })],
        Answer: [
          answer('"ignored"', { type: 5 }),
          answer('"ignored"', { name: 'elsewhere.example.' }),
          answer(' "iss=\\105ssuer" \t "\\.example" ', { name: `${RECORD.toUpperCase()}` }),
        ],
      })
    );
    expect(result).toEqual(OK);
  });

  it('fails discovery when the resolver throws', async () => {
    const { result } = await viaDoh(async () => {
      throw new Error('down');
    });
    expect(result).toEqual(fail('issuer_discovery_failed'));
  });
});

describe('email verification protocol: the issuer record', () => {
  it.each([
    ['an empty issuer', ['iss=']],
    ['an issuer with a path', ['iss=issuer.example/x']],
    ['an issuer of one label', ['iss=issuer']],
    ['a non-string record', [7 as unknown as string]],
  ])('fails discovery for %s', async (_label, records) => {
    const token = await createPresentation();
    await expect(verify(token, { resolveDnsTxt: async () => records })).resolves.toEqual(
      fail('issuer_discovery_failed')
    );
  });

  it('reads metadata from the issuer it discovered', async () => {
    const token = await createPresentation();
    const fetchJson = createProviderFetch(fixture().issuerJwk);
    await expect(verify(token, { fetchJson })).resolves.toEqual(OK);
    expect(fetchJson.mock.calls.map((call) => call[0])).toEqual([
      `${ISSUER}/.well-known/email-verification`,
      JWKS_URL,
    ]);
  });
});

describe('email verification protocol: issuer metadata and keys', () => {
  const issuerJwk = () => fixture().issuerJwk;
  const withMetadata = async (metadata: unknown) =>
    verify(await createPresentation(), {
      fetchJson: createProviderFetch(issuerJwk(), { metadata }),
    });
  const withJwks = async (jwks: unknown, token?: string) =>
    verify(token ?? (await createPresentation()), {
      fetchJson: createProviderFetch(issuerJwk(), { jwks }),
    });

  it.each([
    ['not an object', ['x']],
    ['another issuer', { issuer: 'https://other.example', jwks_uri: JWKS_URL }],
    ['no jwks_uri', {}],
    ['a non-string jwks_uri', { jwks_uri: 5 }],
    ['an unparseable jwks_uri', { jwks_uri: 'https://' }],
    ['a jwks_uri with user info', { jwks_uri: 'https://u:p@keys.cdn.example/jwks' }],
    ['a jwks_uri with a password only', { jwks_uri: 'https://:p@keys.cdn.example/jwks' }],
    ['a jwks_uri with a fragment', { jwks_uri: `${JWKS_URL}#k` }],
    [
      'an http issuance endpoint',
      { jwks_uri: JWKS_URL, issuance_endpoint: 'http://issuer.example/i' },
    ],
    [
      'an issuance endpoint on a look-alike host',
      { jwks_uri: JWKS_URL, issuance_endpoint: 'https://evilissuer.example/i' },
    ],
  ])('fails metadata for %s', async (_label, metadata) => {
    await expect(withMetadata(metadata)).resolves.toEqual(fail('issuer_metadata_failed'));
  });

  it.each([
    ['the issuer named', { issuer: ISSUER, jwks_uri: JWKS_URL }],
    [
      'an issuance endpoint on the issuer',
      { jwks_uri: JWKS_URL, issuance_endpoint: `${ISSUER}/i` },
    ],
    [
      'an issuance endpoint on a subdomain',
      { jwks_uri: JWKS_URL, issuance_endpoint: 'https://id.issuer.example/i' },
    ],
  ])('accepts metadata with %s', async (_label, metadata) => {
    await expect(withMetadata(metadata)).resolves.toEqual(OK);
  });

  it.each([
    ['not an object', 'keys'],
    ['no key list', { keys: 'k' }],
    ['an empty key list', { keys: [] }],
    ['more than 32 keys', { keys: Array.from({ length: 33 }, () => ({ kty: 'OKP' })) }],
    ['a key that is not an object', { keys: ['k'] }],
  ])('fails metadata for a JWKS that is %s', async (_label, jwks) => {
    await expect(withJwks(jwks)).resolves.toEqual(fail('issuer_metadata_failed'));
  });

  it('fails metadata when the JWKS cannot be fetched', async () => {
    await expect(
      verify(await createPresentation(), {
        fetchJson: createProviderFetch(issuerJwk(), { throwAt: 'jwks' }),
      })
    ).resolves.toEqual(fail('issuer_metadata_failed'));
  });

  it('takes the signing key among 32', async () => {
    const decoys = Array.from({ length: 31 }, (_, i) => ({
      kty: 'OKP',
      crv: 'Ed25519',
      kid: `k${i}`,
      x: 'AA',
    }));
    await expect(withJwks({ keys: [...decoys, issuerJwk()] })).resolves.toEqual(OK);
  });

  it.each([
    ['another kid', { kid: 'other' }],
    ['a private part', { d: 'secret' }],
    ['another use', { use: 'enc' }],
    ['another algorithm', { alg: 'ES256' }],
    ['no verify operation', { key_ops: ['sign'] }],
    ['another key type', { kty: 'EC' }],
  ])('refuses an issuer key with %s', async (_label, change) => {
    await expect(withJwks({ keys: [{ ...issuerJwk(), ...change }] })).resolves.toEqual(
      fail('invalid_signature')
    );
  });

  it('matches by kid only when the JWKS has key ids', async () => {
    const other: JWK = { ...fixture().holderJwk, kid: 'EdDSA-issuer-key' };
    const token = await createPresentation();
    await expect(withJwks({ keys: [other, issuerJwk()] }, token)).resolves.toEqual(OK);
    const { kid: _kid, ...unnamed } = issuerJwk();
    const tokenWithoutKid = await createPresentation({ issuerHeader: { kid: undefined } });
    await expect(
      withJwks({ keys: [{ ...fixture().holderJwk, kid: 'x' }, unnamed] }, tokenWithoutKid)
    ).resolves.toEqual(OK);
    await expect(withJwks({ keys: [{ ...issuerJwk(), kid: 'renamed' }] }, token)).resolves.toEqual(
      fail('invalid_signature')
    );
    await expect(withJwks({ keys: [{ ...issuerJwk(), kid: '' }] }, token)).resolves.toEqual(OK);
  });
});
