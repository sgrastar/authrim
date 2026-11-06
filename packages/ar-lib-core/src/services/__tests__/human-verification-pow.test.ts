import { describe, expect, it } from 'vitest';
import {
  createPowChallenge,
  parsePowKeyring,
  verifyPowSolution,
  type PowChallenge,
  type PowKeyring,
} from '../human-verification-pow';

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

const KEY_1 = base64Url(new Uint8Array(32).fill(1));
const KEY_2 = base64Url(new Uint8Array(32).fill(2));
const keyring = parsePowKeyring(JSON.stringify({ current: 1, keys: { '1': KEY_1 } }));
const NOW = 1_800_000_000;
const BINDING = { tenantId: 'tenant-a', action: 'login' as const, policyRevision: 'rev-1' };
const MAX = 40;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the browser does: try every number until the hash matches. */
async function solve(challenge: PowChallenge): Promise<number> {
  for (let number = 0; number <= challenge.maxnumber; number += 1) {
    if ((await sha256Hex(`${challenge.salt}${number}`)) === challenge.challenge) return number;
  }
  throw new Error('no solution');
}

function payload(solution: Record<string, unknown>): string {
  return btoa(JSON.stringify(solution));
}

async function issueAndSolve(ring: PowKeyring = keyring) {
  const challenge = await createPowChallenge(ring, BINDING, {
    maxNumber: MAX,
    ttlSeconds: 600,
    nowSeconds: NOW,
  });
  const number = await solve(challenge);
  const solution = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    number,
    salt: challenge.salt,
    signature: challenge.signature,
  };
  return { challenge, solution };
}

const verify = (value: unknown, overrides: Partial<typeof BINDING & { nowSeconds: number }> = {}) =>
  verifyPowSolution(keyring, value, { ...BINDING, maxNumber: MAX, nowSeconds: NOW, ...overrides });

describe('parsePowKeyring', () => {
  it('reads keys of exactly 32 bytes', () => {
    const ring = parsePowKeyring(
      JSON.stringify({ current: '2', keys: { '1': KEY_1, '2': KEY_2 } })
    );
    expect(ring.currentKid).toBe('2');
    expect(ring.keys.size).toBe(2);
  });

  it.each([
    'not json',
    JSON.stringify({ current: 1, keys: { '1': base64Url(new Uint8Array(31)) } }),
    JSON.stringify({ current: 1, keys: { '1': base64Url(new Uint8Array(33)) } }),
    JSON.stringify({ current: 2, keys: { '1': KEY_1 } }),
    JSON.stringify({ current: 1, keys: { '01': KEY_1 } }),
    JSON.stringify({ current: 1, keys: {} }),
    JSON.stringify({ current: 1, keys: { '1': KEY_1 }, extra: true }),
    JSON.stringify({ current: 1, keys: { '1': 'not base64url!' } }),
  ])('refuses %s', (value) => {
    expect(() => parsePowKeyring(value)).toThrow('pow_keyring_invalid');
  });
});

describe('createPowChallenge / verifyPowSolution', () => {
  it('issues a salt in the canonical form and accepts its solution once identified', async () => {
    const { challenge, solution } = await issueAndSolve();
    expect(challenge.salt).toMatch(
      /^[0-9a-f]{24}\?expires=1800000600&action=login&tenant=[0-9a-f]{32}&rev=rev-1&kid=1&$/u
    );
    const result = await verify(payload(solution));
    expect(result).toMatchObject({ ok: true, expiresAt: NOW + 600 });
    // The same salt always names the same use.
    expect(await verify(payload(solution))).toEqual(result);
  });

  it('refuses a proof for another tenant, action or policy revision', async () => {
    const { solution } = await issueAndSolve();
    for (const override of [
      { tenantId: 'tenant-b' },
      { action: 'signup' as const },
      { policyRevision: 'rev-2' },
    ]) {
      expect(await verify(payload(solution), override)).toEqual({ ok: false, reason: 'binding' });
    }
  });

  it('refuses an expired proof and one that claims too long a life', async () => {
    const { solution } = await issueAndSolve();
    expect(await verify(payload(solution), { nowSeconds: NOW + 600 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    const far = solution.salt.replace('expires=1800000600', `expires=${NOW + 100_000}`);
    expect(await verify(payload({ ...solution, salt: far }))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a salt that is not exactly canonical', async () => {
    const { solution } = await issueAndSolve();
    const salt = solution.salt;
    const variants = [
      salt.slice(0, -1), // no trailing delimiter
      salt.replace('&rev=rev-1', '&rev=rev-1&rev=rev-1'), // repeated
      salt.replace('&kid=1&', '&kid=1&extra=1&'), // extra
      salt.replace('action=login&tenant', 'tenant'), // missing
      salt.replace('?expires=1800000600&action=login', '?action=login&expires=1800000600'), // order
      salt.replace('action=login', 'action=%6Cogin'), // encoding
    ];
    for (const variant of variants) {
      expect(await verify(payload({ ...solution, salt: variant }))).toMatchObject({ ok: false });
    }
  });

  it('refuses moving digits between the salt and the number', async () => {
    const { solution } = await issueAndSolve();
    // Without the trailing `&`, `…kid=1` + `23` and `…kid=12` + `3` would hash alike.
    const moved = { ...solution, salt: `${solution.salt}1`, number: 0 };
    expect(await verify(payload(moved))).toEqual({ ok: false, reason: 'salt' });
  });

  it('refuses a wrong number, challenge or signature, and an unknown key', async () => {
    const { solution } = await issueAndSolve();
    expect(await verify(payload({ ...solution, number: MAX + 1 }))).toEqual({
      ok: false,
      reason: 'number',
    });
    expect(await verify(payload({ ...solution, number: -1 }))).toEqual({
      ok: false,
      reason: 'number',
    });
    expect(await verify(payload({ ...solution, number: 1.5 }))).toEqual({
      ok: false,
      reason: 'number',
    });
    const otherNumber = solution.number === 0 ? 1 : 0;
    expect(await verify(payload({ ...solution, number: otherNumber }))).toEqual({
      ok: false,
      reason: 'challenge',
    });
    expect(await verify(payload({ ...solution, signature: '0'.repeat(64) }))).toEqual({
      ok: false,
      reason: 'signature',
    });
    const unknownKid = solution.salt.replace('&kid=1&', '&kid=9&');
    const rehashed = await sha256Hex(`${unknownKid}${solution.number}`);
    expect(await verify(payload({ ...solution, salt: unknownKid, challenge: rehashed }))).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('refuses a proof signed by another key with the same kid', async () => {
    const other = parsePowKeyring(JSON.stringify({ current: 1, keys: { '1': KEY_2 } }));
    const { solution } = await issueAndSolve(other);
    expect(await verify(payload(solution))).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses payloads that are not the five ALTCHA fields', async () => {
    const { solution } = await issueAndSolve();
    expect(await verify('not base64!')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verify(btoa('[1,2]'))).toEqual({ ok: false, reason: 'malformed' });
    expect(await verify(payload({ ...solution, extra: 1 }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verify(payload({ ...solution, algorithm: 'SHA-1' }))).toEqual({
      ok: false,
      reason: 'algorithm',
    });
    expect(await verify('A'.repeat(4096))).toEqual({ ok: false, reason: 'malformed' });
    expect(await verify(42)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses out-of-range issuing options', async () => {
    await expect(
      createPowChallenge(keyring, BINDING, { maxNumber: 0, ttlSeconds: 600 })
    ).rejects.toThrow('pow_max_number_invalid');
    await expect(
      createPowChallenge(keyring, BINDING, { maxNumber: 10, ttlSeconds: 99_999 })
    ).rejects.toThrow('pow_ttl_invalid');
  });
});
