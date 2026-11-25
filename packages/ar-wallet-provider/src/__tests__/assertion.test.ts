import { beforeAll, describe, expect, it } from 'vitest';
import { verifyAssertion } from '../domain/app-attest-assertion';
import type { AppAttestPolicy } from '../domain/app-attest-policy';
import { buildClientData, jwkThumbprint } from '../domain/client-data';
import { sha256, toHex, utf8 } from '../domain/bytes';
import type { CV } from './support/der';
import {
  makeAppleWorld,
  makeAssertion,
  makeAttestation,
  type DeviceFixture,
} from './support/apple-fixture';

const APP_ID = 'TEAM123456.com.authrim.keyring';
let device: DeviceFixture;
let appIdHash: string;
let policy: AppAttestPolicy;
const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) } as const;

beforeAll(async () => {
  const world = await makeAppleWorld(1_800_000_000);
  device = await makeAttestation(world);
  appIdHash = toHex(await sha256(utf8(APP_ID)));
  policy = {
    appIds: [APP_ID],
    environments: ['development'],
    allowedCategories: [4],
    requireCategory: false,
    categoryByteOrder: 'big',
    appleRootDer: world.rootDer,
    appleRootSha256: world.rootSha256,
  };
});

async function check(
  assertion: string,
  clientData: string,
  over: Partial<{
    storedCounter: number;
    appIdHash: string;
    policy: Partial<AppAttestPolicy>;
    publicPoint: Uint8Array;
  }> = {}
) {
  return verifyAssertion(
    {
      assertion,
      clientData,
      publicPoint: over.publicPoint ?? device.point,
      storedCounter: over.storedCounter ?? 0,
      appIdHash: over.appIdHash ?? appIdHash,
    },
    { ...policy, ...over.policy }
  );
}

describe('client data', () => {
  it('has the contract shape, with the nonce line only for key attestation', async () => {
    const thumb = await jwkThumbprint(jwk);
    expect(await buildClientData({ purpose: 'wallet-attestation', challenge: 'c1', jwk })).toBe(
      `authrim-wallet-provider/v1\nwallet-attestation\nc1\n${thumb}`
    );
    expect(
      await buildClientData({ purpose: 'key-attestation', challenge: 'c1', jwk, nonce: 'n1' })
    ).toBe(`authrim-wallet-provider/v1\nkey-attestation\nc1\n${thumb}\nn1`);
  });
});

describe('App Attest assertion', () => {
  it('accepts a valid assertion and returns its counter', async () => {
    const clientData = await buildClientData({
      purpose: 'wallet-attestation',
      challenge: 'c1',
      jwk,
    });
    const r = await check(await makeAssertion(device, clientData, { counter: 5 }), clientData, {
      storedCounter: 2,
    });
    expect(r).toEqual({ ok: true, counter: 5, build: {} });
  });

  it('refuses a counter that is not greater, a tampered signature, other client data, another key', async () => {
    const data = 'authrim-wallet-provider/v1\nwallet-attestation\nc\nt';
    const good = await makeAssertion(device, data, { counter: 3 });
    expect(await check(good, data, { storedCounter: 3 })).toEqual({
      ok: false,
      reason: 'counter_not_greater',
    });
    expect(await check(good, data, { storedCounter: 9 })).toEqual({
      ok: false,
      reason: 'counter_not_greater',
    });
    expect(
      await check(await makeAssertion(device, data, { counter: 3, tamper: true }), data)
    ).toEqual({ ok: false, reason: 'signature_invalid' });
    expect(await check(good, data + 'x')).toEqual({ ok: false, reason: 'signature_invalid' });
    const world = await makeAppleWorld(1_800_000_000);
    const other = await makeAttestation(world);
    expect(await check(good, data, { publicPoint: other.point })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });

  it('refuses a different App ID', async () => {
    const data = 'd';
    const a = await makeAssertion(device, data, { counter: 1, appId: 'TEAM123456.com.other' });
    expect(await check(a, data)).toEqual({ ok: false, reason: 'app_id_mismatch' });
  });

  it('refuses malformed input', async () => {
    expect(await check('@@@', 'd')).toEqual({ ok: false, reason: 'malformed_input' });
    expect(await check(btoa('\xff'), 'd')).toEqual({ ok: false, reason: 'cbor_invalid' });
    expect(await check(btoa('\x01'), 'd')).toEqual({ ok: false, reason: 'format_invalid' });
    expect(
      await check(await makeAssertion(device, 'd', { counter: 1 }), 'd', {
        publicPoint: new Uint8Array(10),
      })
    ).toEqual({ ok: false, reason: 'malformed_input' });
  });

  it('applies the build policy only to what the assertion carries, or to everything when the category is required', async () => {
    const ext = (category: number) =>
      new Map<string, CV>([
        ['apple_validation_category_01', category],
        ['apple_bundle_version_01', '2.0'],
      ]);
    const bad = await makeAssertion(device, 'd', { counter: 1, extensions: ext(5) });
    expect(await check(bad, 'd')).toEqual({ ok: false, reason: 'build_not_allowed' });
    const good = await makeAssertion(device, 'd', { counter: 1, extensions: ext(4) });
    expect(await check(good, 'd')).toEqual({
      ok: true,
      counter: 1,
      build: { validationCategory: 4, bundleVersion: '2.0' },
    });
    // requireCategory switched on: an assertion without a category is refused (migration case)
    const none = await makeAssertion(device, 'd', { counter: 1 });
    expect(await check(none, 'd', { policy: { requireCategory: true } })).toEqual({
      ok: false,
      reason: 'build_not_allowed',
    });
    expect(await check(none, 'd', { policy: { requireCategory: false } })).toEqual({
      ok: true,
      counter: 1,
      build: {},
    });
    expect(await check(good, 'd', { policy: { minBundleVersion: '2.1' } })).toEqual({
      ok: false,
      reason: 'build_not_allowed',
    });
    const badField = await makeAssertion(device, 'd', {
      counter: 1,
      extensions: new Map<string, CV>([['apple_validation_category_01', 'x']]),
    });
    expect(await check(badField, 'd')).toEqual({ ok: false, reason: 'extensions_invalid' });
  });
});
