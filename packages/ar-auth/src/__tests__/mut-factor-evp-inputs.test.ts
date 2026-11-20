import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUDIENCE,
  EMAIL,
  NOW,
  OK,
  createPresentation,
  editSegment,
  fail,
  loadFixtures,
  verify,
} from './helpers/mut-factor-evp-fixtures';

beforeAll(loadFixtures);
afterEach(() => vi.useRealTimers());

describe('email verification protocol: programmer inputs', () => {
  it.each([
    ['an empty address', ''],
    ['an address over 254 characters', `${'a'.repeat(60)}@${'b'.repeat(190)}.com`],
    ['surrounding space', ' user@example.com'],
    ['no at sign', 'user.example.com'],
    ['an empty local part', '@example.com'],
    ['two at signs', 'us@er@example.com'],
    ['a local part over 64 characters', `${'a'.repeat(65)}@example.com`],
    ['a control character', 'us\u0001er@example.com'],
    ['an inner space', 'us er@example.com'],
    ['a single-label domain', 'user@localhost'],
    ['a domain label over 63 characters', `user@${'a'.repeat(64)}.com`],
    ['an underscore label', 'user@ex_ample.com'],
    ['a label starting with a hyphen', 'user@-example.com'],
    ['a label ending with a hyphen', 'user@example-.com'],
    ['an empty label', 'user@example..com'],
    ['a trailing dot', 'user@example.com.'],
    ['a leading dot', 'user@.example.com'],
    ['a port', 'user@example.com:443'],
    ['a path', 'user@example.com/x'],
    ['a bracketed host', 'user@[127.0.0.1]'],
  ])('throws for %s', async (_label, expectedEmail) => {
    await expect(verify('x', { expectedEmail })).rejects.toThrow(
      'expectedEmail must be a valid mailbox with a DNS domain'
    );
  });

  it('accepts a local part of 64 characters and a 63-character label', async () => {
    const resolveDnsTxt = vi.fn(async () => [] as string[]);
    const expectedEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.Example.COM`;
    await expect(verify('not-a-token', { expectedEmail, resolveDnsTxt })).resolves.toEqual(
      fail('invalid_presentation')
    );
  });

  it('asks DNS for the lowercased mailbox domain', async () => {
    const token = await createPresentation({ issuerPayload: { email: 'user@Sub.Example.com' } });
    const resolveDnsTxt = vi.fn(async () => ['iss=issuer.example']);
    await expect(
      verify(token, { expectedEmail: 'user@Sub.Example.com', resolveDnsTxt })
    ).resolves.toEqual(OK);
    expect(resolveDnsTxt).toHaveBeenCalledWith('_email-verification.sub.example.com');
  });

  it.each([
    ['an empty nonce', ''],
    ['a nonce over 1024 characters', 'n'.repeat(1025)],
    ['a non-string nonce', 5 as unknown as string],
  ])('throws for %s', async (_label, expectedNonce) => {
    await expect(verify('x', { expectedNonce })).rejects.toThrow(
      'expectedNonce must be a non-empty string'
    );
  });

  it('accepts a nonce of 1024 characters', async () => {
    const nonce = 'n'.repeat(1024);
    const token = await createPresentation({ keyBindingPayload: { nonce } });
    await expect(verify(token, { expectedNonce: nonce })).resolves.toEqual(OK);
  });

  it.each([
    ['an http origin', 'http://rp.example'],
    ['user info', 'https://user@rp.example'],
    ['a password', 'https://:pw@rp.example'],
    ['a query', 'https://rp.example/?q=1'],
    ['a fragment', 'https://rp.example/#f'],
    ['a path', 'https://rp.example/cb'],
    ['an unparseable value', 'not a url'],
  ])('throws for an audience with %s', async (_label, expectedAudience) => {
    await expect(verify('x', { expectedAudience })).rejects.toThrow(
      'expectedAudience must be an HTTPS origin'
    );
  });

  it('compares the audience as an origin', async () => {
    const token = await createPresentation({
      keyBindingPayload: { aud: 'https://rp.example:8443' },
    });
    await expect(verify(token, { expectedAudience: 'https://RP.example:8443/' })).resolves.toEqual(
      OK
    );
    const plain = await createPresentation({ keyBindingPayload: { aud: `${AUDIENCE}/` } });
    await expect(verify(plain)).resolves.toEqual(fail('invalid_claims'));
  });

  it.each([[-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]])('throws for the clock %d', async (now) => {
    await expect(verify('x', { nowSeconds: now })).rejects.toThrow(
      'nowSeconds must be a non-negative safe integer'
    );
  });

  it('accepts a clock of zero and reads the system clock without one', async () => {
    await expect(verify('x', { nowSeconds: 0 })).resolves.toEqual(fail('invalid_presentation'));
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000 + 999);
    const token = await createPresentation();
    await expect(verify(token, { nowSeconds: undefined })).resolves.toEqual(OK);
    vi.setSystemTime((NOW + 400) * 1000);
    await expect(verify(token, { nowSeconds: undefined })).resolves.toEqual(
      fail('token_not_current')
    );
  });
});

describe('email verification protocol: presentation grammar', () => {
  it.each([
    ['empty', ''],
    ['without a key-binding part', 'a.b.c'],
    ['an empty segment', 'a.b.c~~d.e.f'],
    ['characters outside the alphabet', 'a.b.c~d+e.f.g'],
    ['a non-string token', 42 as unknown as string],
    ['an issuer part that is not a compact JWT', 'a.b~d.e.f'],
    ['a key-binding part that is not a compact JWT', 'a.b.c~d.e'],
    ['a disclosure with a dot', 'a.b.c~x.y~d.e.f'],
    ['an empty JWT segment', 'a..c~d.e.f'],
  ])('refuses %s without asking DNS', async (_label, token) => {
    const resolveDnsTxt = vi.fn(async () => ['iss=issuer.example']);
    await expect(verify(token, { resolveDnsTxt })).resolves.toEqual(fail('invalid_presentation'));
    expect(resolveDnsTxt).not.toHaveBeenCalled();
  });

  it('refuses a token over 64 KiB and accepts one just under', async () => {
    const resolveDnsTxt = vi.fn(async () => ['iss=issuer.example']);
    const oversized = `a.b.c~${'d'.repeat(64 * 1024)}~e.f.g`;
    await expect(verify(oversized, { resolveDnsTxt })).resolves.toEqual(
      fail('invalid_presentation')
    );
    const token = await createPresentation({
      issuerPayload: { padding: 'p'.repeat(40_000) },
    });
    expect(token.length).toBeLessThan(64 * 1024);
    await expect(verify(token)).resolves.toEqual(OK);
  });

  it.each([
    ['a crit header', { crit: ['exp'] }],
    ['an empty kid', { kid: '' }],
    ['a numeric kid', { kid: 7 }],
    ['no alg', { alg: undefined }],
  ])('refuses an issuer JWT with %s', async (_label, header) => {
    const token = editSegment(await createPresentation(), 'issuer', 0, (value) => ({
      ...value,
      ...header,
    }));
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses a key-binding JWT with a crit header', async () => {
    const token = editSegment(await createPresentation(), 'kb', 0, (value) => ({
      ...value,
      crit: ['exp'],
    }));
    await expect(verify(token)).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses a JWT whose payload is not JSON', async () => {
    const token = await createPresentation();
    const parts = token.split('~');
    const jwt = parts[0].split('.');
    jwt[1] = 'bm90LWpzb24';
    parts[0] = jwt.join('.');
    await expect(verify(parts.join('~'))).resolves.toEqual(fail('invalid_presentation'));
  });

  it('refuses an issuer JWT whose iss is not the discovered issuer', async () => {
    const token = await createPresentation({ issuerPayload: { iss: 'https://other.example' } });
    await expect(verify(token)).resolves.toEqual(fail('invalid_claims'));
  });

  it('expects the mailbox it was given', async () => {
    const token = await createPresentation({ issuerPayload: { email: 'user@example.co' } });
    await expect(verify(token, { expectedEmail: 'user@example.com' })).resolves.toEqual(
      fail('invalid_claims')
    );
    expect(EMAIL).toBe('user@example.com');
  });
});
