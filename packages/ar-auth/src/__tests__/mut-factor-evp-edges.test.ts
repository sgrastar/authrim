import { beforeAll, describe, expect, it } from 'vitest';
import { base64url } from 'jose';
import {
  EMAIL,
  ISSUER,
  JWKS_URL,
  OK,
  createPresentation,
  encodeDisclosure,
  fail,
  fixture,
  hash,
  loadFixtures,
  verify,
} from './helpers/mut-factor-evp-fixtures';

beforeAll(loadFixtures);

const bytesDisclosure = (...parts: (string | number[])[]) =>
  base64url.encode(
    Uint8Array.from(
      parts.flatMap((part) =>
        typeof part === 'string' ? [...new TextEncoder().encode(part)] : part
      )
    )
  );

describe('email verification protocol: boundaries', () => {
  it('accepts a mailbox of exactly 254 characters', async () => {
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    const mailbox = `${'a'.repeat(64)}@${domain}`;
    expect(mailbox.length).toBe(254);
    await expect(verify('not-a-token', { expectedEmail: mailbox })).resolves.toEqual(
      fail('invalid_presentation')
    );
    await expect(verify('x', { expectedEmail: `a${mailbox}` })).rejects.toThrow(TypeError);
  });

  it('refuses a domain the URL parser rejects', async () => {
    await expect(verify('x', { expectedEmail: 'user@exa%mple.com' })).rejects.toThrow(TypeError);
  });

  it('takes an issuer domain of 253 characters and refuses 254', async () => {
    const label = 'a'.repeat(63);
    const domain253 = `${label}.${label}.${label}.${'b'.repeat(57)}.com`;
    expect(domain253.length).toBe(253);
    const token = await createPresentation();
    await expect(
      verify(token, { resolveDnsTxt: async () => [`iss=${domain253}`] })
    ).resolves.toEqual(fail('invalid_claims'));
    await expect(
      verify(token, { resolveDnsTxt: async () => [`iss=x${domain253}`] })
    ).resolves.toEqual(fail('issuer_discovery_failed'));
  });

  it('folds A and Z on either side', async () => {
    const claim = await createPresentation({ issuerPayload: { email: 'AZuser@example.com' } });
    await expect(verify(claim, { expectedEmail: 'azuser@example.com' })).resolves.toEqual(OK);
    const lower = await createPresentation({ issuerPayload: { email: 'azuser@example.com' } });
    await expect(verify(lower, { expectedEmail: 'AZuser@example.com' })).resolves.toEqual(OK);
    const neighbours = await createPresentation({ issuerPayload: { email: '@[user@example.com' } });
    await expect(verify(neighbours, { expectedEmail: '`{user@example.com' })).resolves.toEqual(
      fail('invalid_claims')
    );
  });
});

describe('email verification protocol: digests and decoding', () => {
  const withoutEmail = { email: undefined };

  it.each([
    ['one digest of 44 characters', (good: string) => [good, 'a'.repeat(44)]],
    ['one digest with a leading symbol', (good: string) => [good, `=${'a'.repeat(43)}`]],
    ['one digest that is too short', (good: string) => ['a'.repeat(42), good]],
  ])('refuses a digest list with %s', async (_label, list) => {
    const encoded = encodeDisclosure(['salt', 'email', EMAIL]);
    const token = await createPresentation({
      rawDisclosures: [encoded],
      sd: list(await hash(encoded)),
      issuerPayload: withoutEmail,
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses a disclosure that is not valid UTF-8 even inside a string', async () => {
    const encoded = bytesDisclosure('["salt","nickname","', [0xff], '"]');
    const token = await createPresentation({ rawDisclosures: [encoded] });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('reads a disclosure that starts with a byte order mark', async () => {
    const encoded = bytesDisclosure([0xef, 0xbb, 0xbf], '["salt","nickname","Al"]');
    const token = await createPresentation({ rawDisclosures: [encoded] });
    await expect(verify(token)).resolves.toEqual(OK);
  });
});

describe('email verification protocol: JWKS URLs that are refused', () => {
  /** A provider that serves the keys at any URL, so only the URL checks can refuse one. */
  const lenientFetch = (jwksUri: string) => async (url: string) =>
    url === `${ISSUER}/.well-known/email-verification`
      ? { jwks_uri: jwksUri }
      : { keys: [fixture().issuerJwk] };

  it.each([
    ['user info', 'https://u:p@keys.cdn.example/jwks'],
    ['a user name', 'https://u@keys.cdn.example/jwks'],
    ['a password', 'https://:p@keys.cdn.example/jwks'],
    ['a fragment', `${JWKS_URL}#k`],
    ['plain http', 'http://keys.cdn.example/jwks'],
    ['a private address', 'https://10.0.0.1/jwks'],
  ])('refuses a jwks_uri with %s', async (_label, jwksUri) => {
    const token = await createPresentation();
    await expect(verify(token, { fetchJson: lenientFetch(jwksUri) })).resolves.toEqual(
      fail('issuer_metadata_failed')
    );
  });

  it('accepts the same keys at a plain HTTPS URL', async () => {
    const token = await createPresentation();
    await expect(verify(token, { fetchJson: lenientFetch(JWKS_URL) })).resolves.toEqual(OK);
  });
});
