/**
 * Credential endpoint DPoP nonces: the MAC is checked against an independent computation, each
 * window edge and each malformed shape is pinned.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';
import {
  issueCredentialDpopNonce,
  readDpopProofNonce,
  verifyCredentialDpopNonce,
} from '../dpop-nonce';

const SECRET = 'a-server-secret';
const env = { VC_TRANSACTION_CODE_HMAC_SECRET: SECRET } as unknown as Env;
const noSecret = {} as unknown as Env;
const WINDOW = 120;
const WINDOW_MS = WINDOW * 1000;
const CLOCK_MS = 77 * WINDOW_MS + 5000;

afterEach(() => {
  vi.useRealTimers();
});

function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CLOCK_MS);
}

async function rawMac(tenant: string, window: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = new TextEncoder().encode(`vci-credential-dpop-nonce-v1\n${tenant}\n${window}`);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
const standard = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const urlSafe = (bytes: Uint8Array) =>
  standard(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A tenant whose MAC for `window` contains the given standard-base64 character. */
async function tenantWithChar(char: '+' | '/', window: number): Promise<string> {
  for (let index = 0; index < 500; index += 1) {
    const tenant = `tenant-${index}`;
    if (standard(await rawMac(tenant, window)).includes(char)) return tenant;
  }
  throw new Error(`no tenant with ${char}`);
}

describe('issueCredentialDpopNonce', () => {
  it('is null without a server secret', async () => {
    expect(await issueCredentialDpopNonce(noSecret, 't1', 1)).toBeNull();
  });

  it('is the window and the url-safe HMAC of purpose, tenant and window', async () => {
    const now = 5 * WINDOW_MS + 7;
    expect(await issueCredentialDpopNonce(env, 't1', now)).toBe(
      `5.${urlSafe(await rawMac('t1', 5))}`
    );
    expect(await issueCredentialDpopNonce(env, 't1', 6 * WINDOW_MS - 1)).toBe(
      `5.${urlSafe(await rawMac('t1', 5))}`
    );
    expect(await issueCredentialDpopNonce(env, 't1', 6 * WINDOW_MS)).toBe(
      `6.${urlSafe(await rawMac('t1', 6))}`
    );
  });

  it('uses the clock by default', async () => {
    freezeClock();
    expect(await issueCredentialDpopNonce(env, 't1')).toBe(`77.${urlSafe(await rawMac('t1', 77))}`);
  });

  it('writes + and / of the MAC as - and _ and drops the padding', async () => {
    for (const char of ['+', '/'] as const) {
      const tenant = await tenantWithChar(char, 3);
      const nonce = await issueCredentialDpopNonce(env, tenant, 3 * WINDOW_MS);
      const tag = nonce?.split('.')[1] ?? '';
      expect(tag).toBe(urlSafe(await rawMac(tenant, 3)));
      expect(tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe('verifyCredentialDpopNonce', () => {
  const NOW = 50 * WINDOW_MS + 1000;
  const verify = (nonce: unknown, tenant = 't1', now = NOW, e: Env = env) =>
    verifyCredentialDpopNonce(e, tenant, nonce, now);
  const nonceOf = async (window: number, tenant = 't1') =>
    `${window}.${urlSafe(await rawMac(tenant, window))}`;

  it('accepts the current and the previous window only', async () => {
    expect(await verify(await nonceOf(50))).toBe(true);
    expect(await verify(await nonceOf(49))).toBe(true);
    expect(await verify(await nonceOf(48))).toBe(false);
    expect(await verify(await nonceOf(51))).toBe(false);
  });

  it('checks the window at the clock edges', async () => {
    const nonce = await nonceOf(49);
    expect(await verify(nonce, 't1', 51 * WINDOW_MS - 1)).toBe(true);
    expect(await verify(nonce, 't1', 51 * WINDOW_MS)).toBe(false);
  });

  it('uses the clock by default', async () => {
    freezeClock();
    expect(await verifyCredentialDpopNonce(env, 't1', await nonceOf(77))).toBe(true);
    expect(await verifyCredentialDpopNonce(env, 't1', await nonceOf(72))).toBe(false);
  });

  it('is bound to the tenant and to the secret', async () => {
    const nonce = await nonceOf(50);
    expect(await verify(nonce, 't2')).toBe(false);
    expect(
      await verify(nonce, 't1', NOW, { VC_TRANSACTION_CODE_HMAC_SECRET: 'other' } as Env)
    ).toBe(false);
  });

  it('refuses everything without a server secret', async () => {
    expect(await verify(await nonceOf(50), 't1', NOW, noSecret)).toBe(false);
  });

  it('refuses a non-string and an oversized nonce', async () => {
    for (const nonce of [undefined, null, 5, {}, ['50.x']]) {
      expect(await verify(nonce)).toBe(false);
    }
    expect(await verify(`50.${'A'.repeat(200)}`)).toBe(false);
  });

  it('refuses a tag that extends the right one', async () => {
    const good = await nonceOf(50);
    expect(await verify(`${good}A`)).toBe(false);
    expect(await verify(good.slice(0, -1))).toBe(false);
  });

  it('refuses extra segments and a missing tag', async () => {
    const good = await nonceOf(50);
    expect(await verify(`${good}.extra`)).toBe(false);
    expect(await verify(`${good}.`)).toBe(false);
    expect(await verify('50')).toBe(false);
    expect(await verify('50.')).toBe(false);
  });

  it('refuses a window that is not plain decimal digits', async () => {
    const at16 = 16 * WINDOW_MS;
    const tag = urlSafe(await rawMac('t1', 16));
    expect(await verify(`16.${tag}`, 't1', at16)).toBe(true);
    // Number() reads these as 16 although they are not digits.
    for (const text of ['0x10', ' 16', '16 ', '+16', '1.6e1']) {
      expect(await verify(`${text}.${tag}`, 't1', at16)).toBe(false);
    }
    expect(await verify(`.${tag}`, 't1', at16)).toBe(false);
    expect(await verify(`1234567890123.${tag}`, 't1', at16)).toBe(false);
  });

  it('flips one character of the tag and fails', async () => {
    const good = await nonceOf(50);
    const last = good.at(-1) === 'A' ? 'B' : 'A';
    expect(await verify(`${good.slice(0, -1)}${last}`)).toBe(false);
  });
});

describe('readDpopProofNonce', () => {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const proof = (payload: unknown) => `h.${part(payload)}.s`;

  it('reads a string nonce whatever the padding length of the payload', () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const nonce = `n${'x'.repeat(pad)}`;
      expect(readDpopProofNonce(proof({ nonce }))).toBe(nonce);
    }
  });

  it('decodes url-safe characters', () => {
    const withUrlSafe = [...Array(300).keys()]
      .map((i) => `${String.fromCharCode(62 + (i % 2))}${'?'.repeat(i % 5)}`)
      .find((nonce) => /[+/]/.test(btoa(JSON.stringify({ nonce }))));
    expect(withUrlSafe).toBeDefined();
    expect(readDpopProofNonce(proof({ nonce: withUrlSafe }))).toBe(withUrlSafe);
  });

  it('is undefined for a missing, non-string or unreadable nonce', () => {
    expect(readDpopProofNonce(proof({}))).toBeUndefined();
    expect(readDpopProofNonce(proof({ nonce: 5 }))).toBeUndefined();
    expect(readDpopProofNonce('no-dot')).toBeUndefined();
    expect(readDpopProofNonce('h.!!!.s')).toBeUndefined();
    expect(readDpopProofNonce(`h.${btoa('not json')}.s`)).toBeUndefined();
  });
});
