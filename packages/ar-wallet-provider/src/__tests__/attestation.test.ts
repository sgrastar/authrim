import { beforeAll, describe, expect, it } from 'vitest';
import { verifyAttestation } from '../domain/app-attest-attestation';
import type { AppAttestPolicy } from '../domain/app-attest-policy';
import { enc, oid, octet, seq, bool, type CV } from './support/der';
import {
  makeAppleWorld,
  makeAttestation,
  b64,
  type AppleWorld,
  type AttestOptions,
} from './support/apple-fixture';

const NOW = 1_800_000_000;
const APP_ID = 'TEAM123456.com.authrim.keyring';
let world: AppleWorld;
let policy: AppAttestPolicy;

beforeAll(async () => {
  world = await makeAppleWorld(NOW);
  policy = {
    appIds: [APP_ID],
    environments: ['development', 'production'],
    allowedCategories: [2, 3, 4],
    requireCategory: false,
    categoryByteOrder: 'big',
    appleRootDer: world.rootDer,
    appleRootSha256: world.rootSha256,
  };
});

async function run(
  opts: AttestOptions = {},
  mutate?: Partial<AppAttestPolicy>,
  tweak?: { challenge?: string; keyId?: string; now?: number }
) {
  const device = await makeAttestation(world, opts);
  const result = await verifyAttestation(
    {
      keyId: tweak?.keyId ?? device.keyId,
      challenge: tweak?.challenge ?? device.challenge,
      attestationObject: device.attestationObject,
      now: tweak?.now ?? NOW,
    },
    { ...policy, ...mutate }
  );
  return { device, result };
}
const reason = (r: Awaited<ReturnType<typeof run>>) => (r.result.ok ? 'ok' : r.result.reason);

describe('App Attest attestation: accepts', () => {
  it('a development attestation, recording environment, key and hashes', async () => {
    const { device, result } = await run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attestation.environment).toBe('development');
    expect(result.attestation.keyId).toBe(device.keyId);
    expect(result.attestation.publicKeyJwk.crv).toBe('P-256');
    expect(result.attestation.receipt).toBe(b64(enc('receipt-bytes')));
    expect(result.attestation.attestationSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.attestation.challengeSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('a production attestation', async () => {
    expect(reason(await run({ aaguid: 'production' }))).toBe('ok');
    // Apple's credCert is signed with SHA-256; SHA-384 is not in the default allow-list
    expect(reason(await run({ credHash: 'SHA-384' }))).toBe('chain_untrusted');
  });

  it('reads the category as a 4-byte string in the configured byte order and as an integer', async () => {
    const big = new Map<string, CV>([
      ['apple_validation_category_01', Uint8Array.of(0, 0, 0, 4)],
      ['apple_bundle_version_01', '1.2'],
    ]);
    const r = await run({ extensions: big });
    expect(r.result.ok && r.result.attestation.build).toEqual({
      validationCategory: 4,
      bundleVersion: '1.2',
    });
    const little = new Map<string, CV>([
      ['apple_validation_category_01', Uint8Array.of(4, 0, 0, 0)],
    ]);
    const l = await run({ extensions: little }, { categoryByteOrder: 'little' });
    expect(l.result.ok && l.result.attestation.build.validationCategory).toBe(4);
    const asInt = await run({
      extensions: new Map<string, CV>([['apple_validation_category_01', 3]]),
    });
    expect(asInt.result.ok && asInt.result.attestation.build.validationCategory).toBe(3);
  });

  it('an App ID prefix that differs from any team id', async () => {
    const other = 'ABCDE12345.com.authrim.keyring.staging';
    expect(reason(await run({ appId: other }, { appIds: [other] }))).toBe('ok');
  });
});

describe('App Attest attestation: refuses', () => {
  it('malformed input', async () => {
    expect(reason(await run({}, {}, { keyId: 'not base64!' }))).toBe('malformed_input');
    expect(reason(await run({}, {}, { keyId: b64(new Uint8Array(31)) }))).toBe('malformed_input');
    expect(reason(await run({}, {}, { challenge: '' }))).toBe('malformed_input');
    const device = await makeAttestation(world);
    expect(
      await verifyAttestation(
        { keyId: device.keyId, challenge: 'c', attestationObject: '@@@', now: NOW },
        policy
      )
    ).toEqual({ ok: false, reason: 'malformed_input' });
    expect(
      await verifyAttestation(
        {
          keyId: device.keyId,
          challenge: 'c',
          attestationObject: b64(Uint8Array.of(0xff)),
          now: NOW,
        },
        policy
      )
    ).toEqual({ ok: false, reason: 'cbor_invalid' });
  });

  it('a wrong fmt', async () =>
    expect(reason(await run({ fmt: 'packed' }))).toBe('format_invalid'));
  it('a different challenge (nonce mismatch)', async () =>
    expect(reason(await run({}, {}, { challenge: 'another-challenge' }))).toBe('nonce_mismatch'));
  it('a nonce extension that is missing or wrong', async () => {
    expect(reason(await run({ omitNonce: true }))).toBe('nonce_mismatch');
    expect(reason(await run({ nonceOverride: new Uint8Array(32) }))).toBe('nonce_mismatch');
  });
  it('a key id that is not the hash of the credCert key', async () => {
    const wrong = new Uint8Array(32).fill(1);
    expect(reason(await run({ keyIdOverride: wrong, credentialId: wrong }))).toBe(
      'key_id_mismatch'
    );
  });
  it('an App ID outside the configured list', async () =>
    expect(reason(await run({ appId: 'EVIL000000.com.evil.app' }))).toBe('app_id_mismatch'));
  it('a counter other than zero', async () =>
    expect(reason(await run({ counter: 1 }))).toBe('counter_not_zero'));
  it('an environment the policy does not accept, and an unknown aaguid', async () => {
    expect(reason(await run({ aaguid: 'development' }, { environments: ['production'] }))).toBe(
      'environment_not_allowed'
    );
    expect(reason(await run({ aaguid: enc('0123456789abcdef') }))).toBe('environment_not_allowed');
  });
  it('a credential id that differs from the key id', async () =>
    expect(reason(await run({ credentialId: new Uint8Array(32).fill(2) }))).toBe(
      'credential_id_mismatch'
    ));
  it('a COSE key that is not the credCert key', async () =>
    expect(reason(await run({ coseXOverride: new Uint8Array(32).fill(3) }))).toBe(
      'cose_key_mismatch'
    ));

  it('an expired or not yet valid chain', async () => {
    expect(reason(await run({}, {}, { now: NOW + 10 * 86400 }))).toBe('chain_invalid');
    expect(reason(await run({}, {}, { now: NOW - 100 * 86400 }))).toBe('chain_invalid');
  });
  it('an untrusted root (wrong pin) and a root whose hash does not match', async () => {
    const other = await makeAppleWorld(NOW);
    expect(
      reason(await run({}, { appleRootDer: other.rootDer, appleRootSha256: other.rootSha256 }))
    ).toBe('chain_untrusted');
    expect(reason(await run({}, { appleRootSha256: '0'.repeat(64) }))).toBe('chain_untrusted');
  });
  it('a credCert signature algorithm outside the allow-list', async () => {
    expect(
      reason(
        await run(
          { credHash: 'SHA-384' },
          { credCertSignature: [{ curve: 'P-384', hash: 'SHA-256' }] }
        )
      )
    ).toBe('chain_untrusted');
    expect(reason(await run({ credInnerHash: 'SHA-384' }))).toBe('chain_invalid'); // inner/outer algorithm mismatch
  });
  it('an unknown critical extension in the chain', async () => {
    const critical = seq(oid('1.2.3.4'), bool(true), octet(seq()));
    expect(reason(await run({ extraCredExtensions: [critical] }))).toBe('chain_invalid');
  });
  it('a chain that is not exactly [credCert, intermediate]', async () => {
    expect(reason(await run({ x5cMode: 'single' }))).toBe('format_invalid');
    expect(reason(await run({ x5cMode: 'triple' }))).toBe('format_invalid');
    expect(['chain_invalid', 'chain_untrusted']).toContain(
      reason(await run({ x5cMode: 'swapped' }))
    );
  });

  it('build policy: category not allowed, required but absent, version below the minimum', async () => {
    const ext = (category: number, version?: string) =>
      new Map<string, CV>([
        ['apple_validation_category_01', category],
        ...(version ? ([['apple_bundle_version_01', version]] as [string, CV][]) : []),
      ]);
    expect(reason(await run({ extensions: ext(5) }))).toBe('build_not_allowed');
    expect(reason(await run({}, { requireCategory: true }))).toBe('build_not_allowed');
    expect(reason(await run({ extensions: ext(4, '1.2.9') }, { minBundleVersion: '1.2.10' }))).toBe(
      'build_not_allowed'
    );
    expect(
      reason(await run({ extensions: ext(4, '1.2.10') }, { minBundleVersion: '1.2.10' }))
    ).toBe('ok');
    expect(reason(await run({ extensions: ext(4) }, { minBundleVersion: '1.0' }))).toBe(
      'build_not_allowed'
    ); // version not stated
    expect(
      reason(
        await run({
          extensions: new Map<string, CV>([['apple_validation_category_01', Uint8Array.of(1, 2)]]),
        })
      )
    ).toBe('extensions_invalid');
    expect(
      reason(await run({ extensions: new Map<string, CV>([['apple_bundle_version_01', 5]]) }))
    ).toBe('extensions_invalid');
  });
});
