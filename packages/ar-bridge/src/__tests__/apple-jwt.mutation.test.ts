import * as jose from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLE_DEFAULT_CLIENT_SECRET_TTL,
  APPLE_MAX_CLIENT_SECRET_TTL,
  generateAppleClientSecret,
  parseAppleUserData,
  validateApplePrivateKey,
} from '../utils/apple-jwt';

const NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 999);
const NOW_S = Math.floor(NOW_MS / 1000);
const TEAM = 'ABCDE12345';
const KEY_ID = 'ZYXWV98765';

let privatePem = '';
let publicKey: jose.CryptoKey | jose.KeyObject;

beforeAll(async () => {
  const pair = await jose.generateKeyPair('ES256', { extractable: true });
  privatePem = await jose.exportPKCS8(pair.privateKey);
  publicKey = pair.publicKey;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});
afterEach(() => vi.useRealTimers());

describe('constants', () => {
  it('exposes the documented TTLs', () => {
    expect(APPLE_MAX_CLIENT_SECRET_TTL).toBe(180 * 24 * 3600);
    expect(APPLE_DEFAULT_CLIENT_SECRET_TTL).toBe(30 * 24 * 3600);
  });
});

describe('generateAppleClientSecret', () => {
  it('signs an ES256 JWT with the Apple claims and the default TTL', async () => {
    const jwt = await generateAppleClientSecret(TEAM, 'com.example.app', KEY_ID, privatePem);
    const { payload, protectedHeader } = await jose.jwtVerify(jwt, publicKey, {
      currentDate: new Date(NOW_MS),
    });
    expect(protectedHeader).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(payload).toEqual({
      iss: TEAM,
      sub: 'com.example.app',
      aud: 'https://appleid.apple.com',
      iat: NOW_S,
      exp: NOW_S + 2592000,
    });
  });

  it('honours a shorter TTL', async () => {
    const jwt = await generateAppleClientSecret(TEAM, 'c', KEY_ID, privatePem, 60);
    expect(jose.decodeJwt(jwt).exp).toBe(NOW_S + 60);
  });

  it('allows exactly the maximum TTL and clamps anything above it', async () => {
    const atMax = await generateAppleClientSecret(
      TEAM,
      'c',
      KEY_ID,
      privatePem,
      APPLE_MAX_CLIENT_SECRET_TTL
    );
    expect(jose.decodeJwt(atMax).exp).toBe(NOW_S + 15552000);
    const above = await generateAppleClientSecret(
      TEAM,
      'c',
      KEY_ID,
      privatePem,
      APPLE_MAX_CLIENT_SECRET_TTL + 1
    );
    expect(jose.decodeJwt(above).exp).toBe(NOW_S + 15552000);
  });

  it.each([
    ['', 'Apple Team ID must be exactly 10 characters'],
    ['SHORT', 'Apple Team ID must be exactly 10 characters'],
    ['ABCDE123456', 'Apple Team ID must be exactly 10 characters'],
  ])('rejects team id %j', async (teamId, message) => {
    await expect(generateAppleClientSecret(teamId, 'c', KEY_ID, privatePem)).rejects.toThrow(
      message
    );
  });

  it('rejects an empty client id', async () => {
    await expect(generateAppleClientSecret(TEAM, '', KEY_ID, privatePem)).rejects.toThrow(
      'Apple Client ID (Service ID) is required'
    );
  });

  it.each(['', 'SHORT', 'ZYXWV987654'])('rejects key id %j', async (keyId) => {
    await expect(generateAppleClientSecret(TEAM, 'c', keyId, privatePem)).rejects.toThrow(
      'Apple Key ID must be exactly 10 characters'
    );
  });

  it.each(['', 'not a key'])('rejects a malformed private key %j', async (pem) => {
    await expect(generateAppleClientSecret(TEAM, 'c', KEY_ID, pem)).rejects.toThrow(
      'Invalid private key PEM format'
    );
  });

  it('propagates import errors for a PEM-looking but invalid key', async () => {
    await expect(
      generateAppleClientSecret(
        TEAM,
        'c',
        KEY_ID,
        '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
      )
    ).rejects.toThrow();
  });
});

describe('validateApplePrivateKey', () => {
  const BEGIN = '-----BEGIN PRIVATE KEY-----';
  const END = '-----END PRIVATE KEY-----';
  const body = (n: number) => 'A'.repeat(n);

  it('accepts a PEM with a plausible body length, ignoring whitespace', () => {
    expect(validateApplePrivateKey(`${BEGIN}\n${body(160)}\n${END}\n`)).toBe(true);
    expect(validateApplePrivateKey(privatePem)).toBe(true);
  });

  it('rejects empty input and missing markers', () => {
    expect(validateApplePrivateKey('')).toBe(false);
    expect(validateApplePrivateKey(`${body(150)}\n${END}`)).toBe(false);
    expect(validateApplePrivateKey(`${BEGIN}\n${body(150)}`)).toBe(false);
  });

  it('enforces the 100..300 base64 length bounds inclusively', () => {
    expect(validateApplePrivateKey(`${BEGIN}${body(99)}${END}`)).toBe(false);
    expect(validateApplePrivateKey(`${BEGIN}${body(100)}${END}`)).toBe(true);
    expect(validateApplePrivateKey(`${BEGIN}${body(300)}${END}`)).toBe(true);
    expect(validateApplePrivateKey(`${BEGIN}${body(301)}${END}`)).toBe(false);
  });

  it('does not count whitespace toward the length', () => {
    const spaced = `${BEGIN}\n${'AAAAAAAAAA \n\t'.repeat(9)}\n${END}`; // 90 chars of base64
    expect(validateApplePrivateKey(spaced)).toBe(false);
    const spacedOk = `${BEGIN}\n${'AAAAAAAAAA \n\t'.repeat(10)}\n${END}`; // 100 chars
    expect(validateApplePrivateKey(spacedOk)).toBe(true);
  });
});

describe('parseAppleUserData', () => {
  it('returns null for missing input', () => {
    expect(parseAppleUserData(undefined)).toBeNull();
    expect(parseAppleUserData(null)).toBeNull();
    expect(parseAppleUserData('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseAppleUserData('{not json')).toBeNull();
  });

  it('returns null when nothing usable is present', () => {
    expect(parseAppleUserData('{}')).toBeNull();
    expect(parseAppleUserData('{"name":{}}')).toBeNull();
    expect(parseAppleUserData('{"name":{"firstName":"","lastName":""},"email":""}')).toBeNull();
  });

  it('maps first name, last name, full name and email', () => {
    expect(
      parseAppleUserData(
        JSON.stringify({ name: { firstName: 'John', lastName: 'Doe' }, email: 'j@example.com' })
      )
    ).toEqual({
      given_name: 'John',
      family_name: 'Doe',
      name: 'John Doe',
      email: 'j@example.com',
    });
  });

  it('handles a first name only', () => {
    const result = parseAppleUserData('{"name":{"firstName":"John"}}');
    expect(result).toEqual({ given_name: 'John', name: 'John' });
    expect(result).not.toHaveProperty('family_name');
  });

  it('handles a last name only', () => {
    const result = parseAppleUserData('{"name":{"lastName":"Doe"}}');
    expect(result).toEqual({ family_name: 'Doe', name: 'Doe' });
    expect(result).not.toHaveProperty('given_name');
  });

  it('handles an email only', () => {
    expect(parseAppleUserData('{"email":"a@b.example"}')).toEqual({ email: 'a@b.example' });
  });
});
