import { beforeAll, describe, expect, it } from 'vitest';
import {
  EMAIL,
  NOW,
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

describe('email verification protocol: issued-at, expiry and not-before', () => {
  it.each([
    ['issuer', 'issuerPayload'],
    ['key binding', 'keyBindingPayload'],
  ] as const)('applies the time window to the %s JWT', async (_label, where) => {
    const at = (claims: Record<string, unknown>) => createPresentation({ [where]: claims });
    await expect(verify(await at({ iat: NOW - 300 }))).resolves.toEqual(OK);
    await expect(verify(await at({ iat: NOW + 60 }))).resolves.toEqual(OK);
    await expect(verify(await at({ iat: 'now' }))).resolves.toEqual(fail('invalid_claims'));
    await expect(verify(await at({ iat: NOW + 0.5 }))).resolves.toEqual(fail('invalid_claims'));
    await expect(verify(await at({ iat: undefined }))).resolves.toEqual(fail('invalid_claims'));
    await expect(verify(await at({ exp: NOW + 1 }))).resolves.toEqual(OK);
    await expect(verify(await at({ exp: NOW - 1 }))).resolves.toEqual(fail('token_not_current'));
    await expect(verify(await at({ exp: NOW + 1.5 }))).resolves.toEqual(fail('invalid_claims'));
    await expect(verify(await at({ iat: NOW + 30, exp: NOW + 10 }))).resolves.toEqual(
      fail('invalid_claims')
    );
    await expect(verify(await at({ iat: NOW + 10, exp: NOW + 10 }))).resolves.toEqual(OK);
    await expect(verify(await at({ nbf: NOW }))).resolves.toEqual(OK);
    await expect(verify(await at({ nbf: NOW + 1 }))).resolves.toEqual(fail('token_not_current'));
    await expect(verify(await at({ nbf: 'soon' }))).resolves.toEqual(fail('invalid_claims'));
  });

  it('checks the issuer signature before its times', async () => {
    const token = await createPresentation({
      issuerPayload: { iat: NOW - 1000 },
      issuerPrivateKey: fixture().holderKeys.privateKey,
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_signature'));
  });
});

describe('email verification protocol: the email claims', () => {
  it.each([
    ['a non-string email', { email: 5 }],
    ['a longer email', { email: `${EMAIL}x` }],
    ['an email differing outside ASCII case', { email: 'üser@example.com' }],
    ['an email_verified string', { email_verified: 'true' }],
    ['no email_verified', { email_verified: undefined }],
  ])('refuses %s', async (_label, issuerPayload) => {
    const token = await createPresentation({ issuerPayload });
    await expect(verify(token)).resolves.toEqual(fail('invalid_claims'));
  });

  it('folds ASCII case only', async () => {
    const token = await createPresentation({ issuerPayload: { email: 'USER@EXAMPLE.COM' } });
    await expect(verify(token)).resolves.toEqual(OK);
    const upperNonAscii = await createPresentation({
      issuerPayload: { email: 'Üser@example.com' },
    });
    await expect(verify(upperNonAscii, { expectedEmail: 'üser@example.com' })).resolves.toEqual(
      fail('invalid_claims')
    );
    const lowerExpected = await createPresentation({
      issuerPayload: { email: 'user@example.com' },
    });
    await expect(verify(lowerExpected, { expectedEmail: 'USER@example.com' })).resolves.toEqual(OK);
    const symbol = await createPresentation({ issuerPayload: { email: 'user[example.com' } });
    await expect(verify(symbol, { expectedEmail: 'user@example.com' })).resolves.toEqual(
      fail('invalid_claims')
    );
  });

  it('prefers a disclosed claim over the payload', async () => {
    const token = await createPresentation({
      issuerPayload: { email: undefined },
      disclosures: [{ name: 'email', value: 'other@example.com' }],
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_claims'));
  });
});

describe('email verification protocol: selective disclosures', () => {
  const emailDisclosure = [{ name: 'email', value: EMAIL }];
  const withoutEmail = { email: undefined };

  it('accepts a signed digest list with nothing disclosed', async () => {
    const digest = await hash('unused');
    const token = await createPresentation({ sd: [digest] });
    await expect(verify(token)).resolves.toEqual(OK);
  });

  it.each([
    ['another digest algorithm', { _sd_alg: 'sha-512' }],
    ['a digest list that is not an array', { _sd: 'abc' }],
    ['a digest of the wrong length', { _sd: ['a'.repeat(42)] }],
    ['a digest with other characters', { _sd: [`${'a'.repeat(42)}=`] }],
    ['a non-string digest', { _sd: [7] }],
  ])('refuses %s', async (_label, issuerPayload) => {
    const token = await createPresentation({
      disclosures: emailDisclosure,
      issuerPayload: { ...withoutEmail, ...issuerPayload },
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses repeated digests', async () => {
    const encoded = encodeDisclosure(['salt', 'email', EMAIL]);
    const digest = await hash(encoded);
    const token = await createPresentation({
      rawDisclosures: [encoded],
      sd: [digest, digest],
      issuerPayload: withoutEmail,
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses disclosures when nothing was signed for them', async () => {
    const token = await createPresentation({
      disclosures: emailDisclosure,
      issuerPayload: { ...withoutEmail, _sd: undefined, _sd_alg: undefined },
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('takes sha-256 when no algorithm is named', async () => {
    const token = await createPresentation({
      disclosures: emailDisclosure,
      issuerPayload: { ...withoutEmail, _sd_alg: undefined },
    });
    await expect(verify(token)).resolves.toEqual(OK);
  });

  it.each([
    ['not JSON', 'bm90LWpzb24'],
    ['invalid UTF-8', '_w'],
    ['an object', encodeDisclosure({ salt: 's', name: 'email', value: EMAIL })],
    ['two elements', encodeDisclosure(['salt', 'email'])],
    ['four elements', encodeDisclosure(['salt', 'email', EMAIL, 'x'])],
    ['an empty salt', encodeDisclosure(['', 'email', EMAIL])],
    ['a numeric salt', encodeDisclosure([1, 'email', EMAIL])],
    ['an empty name', encodeDisclosure(['salt', '', EMAIL])],
    ['a numeric name', encodeDisclosure(['salt', 3, EMAIL])],
    ['the _sd name', encodeDisclosure(['salt', '_sd', EMAIL])],
    ['the ... name', encodeDisclosure(['salt', '...', EMAIL])],
  ])('refuses a disclosure that is %s', async (_label, encoded) => {
    const token = await createPresentation({
      rawDisclosures: [encoded],
      issuerPayload: withoutEmail,
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses the same disclosure twice', async () => {
    const encoded = encodeDisclosure(['salt', 'email', EMAIL]);
    const token = await createPresentation({
      rawDisclosures: [encoded, encoded],
      sd: [await hash(encoded)],
      issuerPayload: withoutEmail,
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses two disclosures of one claim', async () => {
    const token = await createPresentation({
      disclosures: [
        { name: 'email', value: EMAIL, salt: 'one' },
        { name: 'email', value: EMAIL, salt: 'two' },
      ],
      issuerPayload: withoutEmail,
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses a disclosure of a claim the payload already has', async () => {
    const token = await createPresentation({ disclosures: emailDisclosure });
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });
});

describe('email verification protocol: holder binding', () => {
  it.each([
    ['no cnf', { cnf: undefined }],
    ['a cnf that is not an object', { cnf: 'key' }],
    ['a cnf without a JWK', { cnf: { kid: 'x' } }],
    ['a cnf JWK that is an array', { cnf: { jwk: [] } }],
  ])('refuses %s', async (_label, issuerPayload) => {
    const token = await createPresentation({ issuerPayload });
    await expect(verify(token)).resolves.toEqual(fail('invalid_claims'));
  });

  it.each([
    ['a private key', { d: 'private' }],
    ['another use', { use: 'enc' }],
    ['another algorithm', { alg: 'ES256' }],
    ['no verify operation', { key_ops: ['sign'] }],
    ['another key type', { kty: 'EC' }],
    ['another curve', { crv: 'X25519' }],
  ])('refuses a holder key with %s', async (_label, change) => {
    const holderJwk = { ...fixture().holderJwk, ...change };
    const token = await createPresentation({ holderJwk });
    await expect(verify(token)).resolves.toEqual(fail('invalid_signature'));
  });

  it('accepts a holder key without alg, use or key_ops', async () => {
    const { alg: _alg, use: _use, key_ops: _ops, kid: _kid, ...bare } = fixture().holderJwk;
    const token = await createPresentation({ holderJwk: bare });
    await expect(verify(token)).resolves.toEqual(OK);
  });

  it.each(['ES256', 'RS256'] as const)('checks the %s holder key type', async (algorithm) => {
    const keys = fixture(algorithm);
    const wrongType = { ...keys.holderJwk, kty: algorithm === 'ES256' ? 'RSA' : 'EC' };
    const token = await createPresentation({ algorithm, holderJwk: wrongType });
    await expect(
      verify(token, {
        fetchJson: async (url: string) =>
          url.endsWith('/.well-known/email-verification')
            ? { jwks_uri: 'https://keys.cdn.example/email-verification.jwks' }
            : { keys: [keys.issuerJwk] },
      })
    ).resolves.toEqual(fail('invalid_signature'));
  });

  it('checks the key binding against the presented SD-JWT', async () => {
    const token = await createPresentation({
      keyBindingPayload: { sd_hash: await hash('other~') },
    });
    await expect(verify(token)).resolves.toEqual(fail('invalid_claims'));
  });
});
