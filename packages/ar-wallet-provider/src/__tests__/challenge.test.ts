import { describe, expect, it } from 'vitest';
import { checkChallenge, createChallenge } from '../domain/challenge';

const secret = new Uint8Array(32).fill(7);
const other = new Uint8Array(32).fill(9);
const base = { environment: 'prod', now: 1_000_000, ttlSeconds: 300 };

describe('stateless challenge', () => {
  it('is 64 printable ASCII characters and verifies until it expires', async () => {
    const challenge = await createChallenge({ secret, ...base });
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(
      await checkChallenge({ challenge, secrets: [secret], environment: 'prod', now: 1_000_300 })
    ).toBe('ok');
    expect(
      await checkChallenge({ challenge, secrets: [secret], environment: 'prod', now: 1_000_301 })
    ).toBe('expired');
  });

  it('is random per call', async () => {
    expect(await createChallenge({ secret, ...base })).not.toBe(
      await createChallenge({ secret, ...base })
    );
  });

  it('rejects another environment, another secret, tampering and junk', async () => {
    const challenge = await createChallenge({ secret, ...base });
    const call = (c: string, s = [secret], environment = 'prod') =>
      checkChallenge({ challenge: c, secrets: s, environment, now: base.now });
    expect(await call(challenge, [secret], 'staging')).toBe('invalid');
    expect(await call(challenge, [other])).toBe('invalid');
    const flipped = (challenge[0] === 'A' ? 'B' : 'A') + challenge.slice(1);
    expect(await call(flipped)).toBe('invalid');
    expect(await call('')).toBe('invalid');
    expect(await call(challenge + 'A')).toBe('invalid');
    expect(await call('%%%')).toBe('invalid');
  });

  it('rejects a challenge whose expiry or MAC bytes were changed, even to a later time', async () => {
    const challenge = await createChallenge({ secret, ...base });
    const raw = Uint8Array.from(atob(challenge.replace(/-/gu, '+').replace(/_/gu, '/')), (c) =>
      c.charCodeAt(0)
    );
    const enc = (b: Uint8Array): string =>
      btoa(String.fromCharCode(...b))
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/u, '');
    const later = raw.slice();
    later[31] += 10; // expiry (last byte of the 8-byte field) moved later
    const mac = raw.slice();
    mac[47] ^= 1;
    for (const forged of [enc(later), enc(mac)]) {
      expect(
        await checkChallenge({
          challenge: forged,
          secrets: [secret],
          environment: 'prod',
          now: base.now,
        })
      ).toBe('invalid');
    }
  });

  it('stops accepting the previous generation once it is removed from the list', async () => {
    const challenge = await createChallenge({ secret: other, ...base });
    expect(
      await checkChallenge({ challenge, secrets: [secret], environment: 'prod', now: base.now })
    ).toBe('invalid');
  });

  it('accepts the previous secret generation during rotation', async () => {
    const challenge = await createChallenge({ secret: other, ...base });
    expect(
      await checkChallenge({
        challenge,
        secrets: [secret, other],
        environment: 'prod',
        now: base.now,
      })
    ).toBe('ok');
  });

  it('refuses weak secrets and wrong random length at creation', async () => {
    await expect(createChallenge({ secret: new Uint8Array(8), ...base })).rejects.toThrow(
      'challenge_input_invalid'
    );
    await expect(createChallenge({ secret, ...base, random: new Uint8Array(3) })).rejects.toThrow(
      'challenge_input_invalid'
    );
  });
});
