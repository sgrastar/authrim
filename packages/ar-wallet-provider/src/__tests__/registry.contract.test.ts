/**
 * Shared contract of `DeviceRegistry` and the rate limiter: the same suite runs against the
 * in-memory reference and the D1 adapter, and later against the DynamoDB adapter (stage W4).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceRecord, DeviceRegistry, WalletProviderRateLimiter } from '@authrim/ar-lib-core';
import { createD1DeviceRegistry } from '../cloudflare/d1-device-registry';
import { createD1RateLimiter, purgeRateLimits } from '../cloudflare/d1-rate-limiter';
import { createD1Shim } from './support/d1-shim';
import { createMemoryRateLimiter, createMemoryRegistry } from './support/memory-ports';

const jwk = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) } as const;
let seq = 0;
function device(over: Partial<DeviceRecord> = {}): DeviceRecord {
  seq += 1;
  return {
    keyId: `key-${seq}`,
    publicKeyJwk: jwk,
    counter: 0,
    environment: 'production',
    validationCategory: 4,
    bundleVersion: '1.0',
    appIdHash: 'a'.repeat(64),
    attestationSha256: `att-${seq}`,
    challengeSha256: `ch-${seq}`,
    receipt: 'cmVjZWlwdA==',
    createdAt: 1000,
    ...over,
  };
}

interface Backend {
  name: string;
  registry: () => DeviceRegistry;
  limiter: (now: () => number) => WalletProviderRateLimiter;
}
const backends: Backend[] = [
  { name: 'memory', registry: createMemoryRegistry, limiter: createMemoryRateLimiter },
  {
    name: 'D1',
    registry: () => createD1DeviceRegistry(createD1Shim()),
    limiter: (now) => createD1RateLimiter(createD1Shim(), now),
  },
];

describe.each(backends)('DeviceRegistry contract: $name', ({ registry: make }) => {
  it('registers once; the same hashes answer same, others conflict', async () => {
    const reg = make();
    const rec = device();
    expect(await reg.register(rec)).toBe('created');
    expect(await reg.register(rec)).toBe('same');
    expect(await reg.register({ ...rec, attestationSha256: 'other' })).toBe('conflict');
    expect(await reg.register({ ...rec, challengeSha256: 'other' })).toBe('conflict');
    const stored = await reg.get(rec.keyId);
    expect(stored).toMatchObject({ counter: 0, validationCategory: 4, bundleVersion: '1.0' });
    expect(stored?.publicKeyJwk).toEqual(jwk);
  });

  it('refuses a second key that presents an already claimed challenge', async () => {
    const reg = make();
    const first = device();
    expect(await reg.register(first)).toBe('created');
    const second = device({ challengeSha256: first.challengeSha256 });
    expect(await reg.register(second)).toBe('challenge_used');
    expect(await reg.get(second.keyId)).toBeNull();
  });

  it('concurrent registrations: one key wins, one challenge is claimed once', async () => {
    const reg = make();
    const rec = device();
    const results = await Promise.all([
      reg.register(rec),
      reg.register(rec),
      reg.register({ ...rec }),
    ]);
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'same')).toHaveLength(2);
    const a = device({ challengeSha256: 'shared' });
    const b = device({ challengeSha256: 'shared' });
    const race = await Promise.all([reg.register(a), reg.register(b)]);
    expect(race.sort()).toEqual(['challenge_used', 'created']);
  });

  it('moves the counter only forward and never accepts one value twice', async () => {
    const reg = make();
    const rec = device();
    await reg.register(rec);
    expect(await reg.advanceCounter(rec.keyId, 5, {}, 2000)).toBe('advanced');
    expect(await reg.advanceCounter(rec.keyId, 5, {}, 2001)).toBe('not_greater');
    expect(await reg.advanceCounter(rec.keyId, 3, {}, 2002)).toBe('not_greater');
    expect((await reg.get(rec.keyId))?.counter).toBe(5);
    const race = await Promise.all(
      [6, 6, 7, 7, 8].map((n) => reg.advanceCounter(rec.keyId, n, {}, 2003))
    );
    expect(race.filter((r) => r === 'advanced').length).toBeGreaterThanOrEqual(1);
    const final = (await reg.get(rec.keyId))?.counter ?? 0;
    expect(final).toBeGreaterThanOrEqual(8);
    expect(await reg.advanceCounter(rec.keyId, final, {}, 2004)).toBe('not_greater');
  });

  it('stores the latest verified build info with the counter', async () => {
    const reg = make();
    const rec = device();
    await reg.register(rec);
    await reg.advanceCounter(rec.keyId, 1, { bundleVersion: '2.0', validationCategory: 4 }, 2000);
    await reg.advanceCounter(rec.keyId, 2, {}, 2001);
    expect(await reg.get(rec.keyId)).toMatchObject({
      bundleVersion: '1.0',
      lastBundleVersion: '2.0',
      lastValidationCategory: 4,
      lastSeenAt: 2001,
    });
  });

  it('answers unknown and revoked for advance, and never creates a record on revoke', async () => {
    const reg = make();
    expect(await reg.advanceCounter('nope', 1, {}, 1)).toBe('unknown');
    expect(await reg.revoke('nope', 'x', 1)).toBe('unknown');
    expect(await reg.get('nope')).toBeNull();
    const rec = device();
    await reg.register(rec);
    expect(await reg.revoke(rec.keyId, 'first reason', 3000)).toBe('revoked');
    expect(await reg.revoke(rec.keyId, 'second reason', 4000)).toBe('already');
    expect(await reg.get(rec.keyId)).toMatchObject({
      revokedAt: 3000,
      revokeReason: 'first reason',
    });
    expect(await reg.advanceCounter(rec.keyId, 9, {}, 5000)).toBe('revoked');
  });

  it('a revoke racing an advance leaves no advance visible after the revoke', async () => {
    const reg = make();
    const rec = device();
    await reg.register(rec);
    await Promise.all([reg.advanceCounter(rec.keyId, 4, {}, 10), reg.revoke(rec.keyId, 'r', 11)]);
    const after = await reg.get(rec.keyId);
    expect(after?.revokedAt).toBe(11);
    expect(await reg.advanceCounter(rec.keyId, 50, {}, 12)).toBe('revoked');
    expect((await reg.get(rec.keyId))?.counter).toBe(after?.counter);
  });

  it('bulk revoke uses the last verified build and skips unknown builds unless asked', async () => {
    const reg = make();
    const old = device({ bundleVersion: '1.0', createdAt: 100 });
    const fresh = device({ bundleVersion: '1.0', createdAt: 200 });
    const unknown = device({
      bundleVersion: undefined,
      validationCategory: undefined,
      createdAt: 300,
    });
    for (const rec of [old, fresh, unknown]) await reg.register(rec);
    await reg.advanceCounter(old.keyId, 1, { bundleVersion: '1.2' }, 10);
    await reg.advanceCounter(fresh.keyId, 1, { bundleVersion: '2.0' }, 10);
    expect(await reg.revokeWhere({ lastBundleVersionLt: '2.0' }, 'bad release', 99)).toBe(1);
    expect((await reg.get(old.keyId))?.revokedAt).toBe(99);
    expect((await reg.get(fresh.keyId))?.revokedAt).toBeUndefined();
    expect((await reg.get(unknown.keyId))?.revokedAt).toBeUndefined();
    expect(
      await reg.revokeWhere({ lastBundleVersionLt: '2.0', includeUnknownBuild: true }, 'x', 100)
    ).toBe(1);
    expect((await reg.get(unknown.keyId))?.revokedAt).toBe(100);
    expect(
      await reg.revokeWhere({ createdBefore: 250, includeUnknownBuild: true }, 'old', 101)
    ).toBe(1);
    expect(await reg.revokeWhere({ lastValidationCategory: 3 }, 'cat', 102)).toBe(0);
  });

  it('revokes across pages (more than one page of devices)', async () => {
    const reg = make();
    for (let i = 0; i < 620; i += 1) {
      await reg.register(device({ keyId: `bulk-${String(i).padStart(4, '0')}`, createdAt: 10 }));
    }
    expect(
      await reg.revokeWhere({ createdBefore: 11, includeUnknownBuild: true }, 'bulk', 50)
    ).toBe(620);
    expect(
      await reg.revokeWhere({ createdBefore: 11, includeUnknownBuild: true }, 'again', 51)
    ).toBe(0);
    expect((await reg.get('bulk-0619'))?.revokeReason).toBe('bulk');
  });

  it('touch is best effort and ignores unknown keys', async () => {
    const reg = make();
    const rec = device();
    await reg.register(rec);
    await reg.touch(rec.keyId, 777);
    await reg.touch('nope', 777);
    expect((await reg.get(rec.keyId))?.lastSeenAt).toBe(777);
  });
});

describe.each(backends)('rate limiter contract: $name', ({ limiter: make }) => {
  it('counts per key inside a fixed window and resets after it', async () => {
    const clock = { t: 10_000 };
    const limiter = make(() => clock.t);
    const rule = { key: 'k', windowSeconds: 60, maxRequests: 2 };
    expect((await limiter.check(rule)).allowed).toBe(true);
    expect(await limiter.check(rule)).toMatchObject({
      allowed: true,
      remaining: 0,
      resetAt: 10_060,
    });
    expect(await limiter.check(rule)).toMatchObject({
      allowed: false,
      remaining: 0,
      resetAt: 10_060,
    });
    expect((await limiter.check({ ...rule, key: 'other' })).allowed).toBe(true);
    clock.t += 60;
    expect(await limiter.check(rule)).toMatchObject({
      allowed: true,
      remaining: 1,
      resetAt: 10_120,
    });
  });

  it('peek reads without counting', async () => {
    const clock = { t: 5_000 };
    const limiter = make(() => clock.t);
    const rule = { key: 'p', windowSeconds: 3600, maxRequests: 1 };
    expect((await limiter.peek(rule)).allowed).toBe(true);
    await limiter.check(rule);
    expect(await limiter.peek(rule)).toMatchObject({ allowed: true, remaining: 0 });
    await limiter.check(rule);
    expect((await limiter.peek(rule)).allowed).toBe(false);
    clock.t += 3600;
    expect((await limiter.peek(rule)).allowed).toBe(true);
  });
});

describe('D1 rate limiter cleanup', () => {
  it('purges counters whose window ended long ago and keeps live ones', async () => {
    const db = createD1Shim();
    const clock = { t: 100_000 };
    const limiter = createD1RateLimiter(db, () => clock.t);
    await limiter.check({ key: 'old', windowSeconds: 60, maxRequests: 5 });
    clock.t += 3 * 3600;
    await limiter.check({ key: 'live', windowSeconds: 60, maxRequests: 5 });
    expect(await purgeRateLimits(db, clock.t)).toBe(1);
    expect((await limiter.peek({ key: 'live', windowSeconds: 60, maxRequests: 5 })).remaining).toBe(
      4
    );
  });
});
