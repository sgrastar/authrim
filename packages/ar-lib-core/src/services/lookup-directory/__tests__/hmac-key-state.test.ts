import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  fingerprintLookupHmacKey,
  loadVerifiedLookupHmacKeyState,
  resolveLookupHmacKeys,
  signLookupHmacKeyState,
  verifyLookupHmacKeyState,
  type LookupHmacKeyStateInput,
} from '../hmac-key-state';

const NOW = 1_800_000_000;
const KEY_A = 'lookup-hmac-key-a-0123456789abcdef0123456789abcdef';
const KEY_B = 'lookup-hmac-key-b-0123456789abcdef0123456789abcdef';
let privateJwk: JWK;
let publicJwk: JWK;
let fingerprintA: string;
let fingerprintB: string;

function state(overrides: Partial<LookupHmacKeyStateInput> = {}): LookupHmacKeyStateInput {
  return {
    environmentId: 'test',
    generation: 4,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    rotationState: 'activation_dual_write',
    writeMode: 'dual_write',
    current: { generation: 2, keyId: 'lookup-key-2', slot: 'B', fingerprint: fingerprintB },
    previous: { generation: 1, keyId: 'lookup-key-1', slot: 'A', fingerprint: fingerprintA },
    ...overrides,
  };
}

describe('signed Lookup HMAC key state', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'registry-key-a', alg: 'EdDSA' };
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'registry-key-a', alg: 'EdDSA' };
    [fingerprintA, fingerprintB] = await Promise.all([
      fingerprintLookupHmacKey(KEY_A),
      fingerprintLookupHmacKey(KEY_B),
    ]);
  });

  it('verifies signed state and resolves bounded read/write keys from local slots', async () => {
    const token = await signLookupHmacKeyState({ state: state(), privateJwk });
    const verified = await verifyLookupHmacKeyState({
      token,
      environmentId: 'test',
      publicJwks: { keys: [publicJwk] },
      now: NOW,
    });
    const resolved = await resolveLookupHmacKeys({ state: verified, slotA: KEY_A, slotB: KEY_B });
    expect(resolved.readKeys.map((key) => key.generation)).toEqual([2, 1]);
    expect(resolved.writeKeys.map((key) => key.generation)).toEqual([2, 1]);

    const currentOnly = await resolveLookupHmacKeys({
      state: { ...verified, rotationState: 'reindexing', writeMode: 'current_only' },
      slotA: KEY_A,
      slotB: KEY_B,
    });
    expect(currentOnly.readKeys.map((key) => key.generation)).toEqual([2, 1]);
    expect(currentOnly.writeKeys.map((key) => key.generation)).toEqual([2]);
  });

  it('rejects tampering, wrong environments, expiry, and private verification material', async () => {
    const token = await signLookupHmacKeyState({ state: state(), privateJwk });
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload.startsWith('e') ? 'f' : 'e'}${payload.slice(1)}.${signature}`;
    await expect(
      verifyLookupHmacKeyState({
        token: tampered,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_hmac_key_state_signature_invalid');
    await expect(
      verifyLookupHmacKeyState({
        token,
        environmentId: 'other',
        publicJwks: { keys: [publicJwk] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_hmac_key_state_claims_invalid');
    await expect(
      verifyLookupHmacKeyState({
        token,
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW + 4000,
      })
    ).rejects.toThrow('lookup_hmac_key_state_claims_invalid');
    await expect(
      verifyLookupHmacKeyState({
        token,
        environmentId: 'test',
        publicJwks: { keys: [privateJwk] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_hmac_key_state_public_jwks_private_material');
  });

  it('rejects invalid key-state combinations and local slot mismatches', async () => {
    await expect(
      signLookupHmacKeyState({
        state: state({ previous: null }),
        privateJwk,
      })
    ).rejects.toThrow('lookup_hmac_key_state_key_set_invalid');
    await expect(
      signLookupHmacKeyState({
        state: state({
          previous: { generation: 1, keyId: 'lookup-key-1', slot: 'B', fingerprint: fingerprintA },
        }),
        privateJwk,
      })
    ).rejects.toThrow('lookup_hmac_key_state_key_set_invalid');
    const token = await signLookupHmacKeyState({ state: state(), privateJwk });
    const verified = await verifyLookupHmacKeyState({
      token,
      environmentId: 'test',
      publicJwks: { keys: [publicJwk] },
      now: NOW,
    });
    await expect(
      resolveLookupHmacKeys({ state: verified, slotA: KEY_A, slotB: `${KEY_B}-wrong` })
    ).rejects.toThrow('lookup_hmac_key_state_local_key_mismatch');
  });

  it('loads only the snapshot matching the separately published generation pointer', async () => {
    const token = await signLookupHmacKeyState({ state: state(), privateJwk });
    const values = new Map([
      [buildLookupHmacKeyStateSnapshotKey('test'), token],
      [buildLookupHmacKeyStateGenerationKey('test'), '4'],
    ]);
    await expect(
      loadVerifiedLookupHmacKeyState({
        store: { get: async (key) => values.get(key) ?? null },
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW,
      })
    ).resolves.toMatchObject({ generation: 4, rotationState: 'activation_dual_write' });
    values.set(buildLookupHmacKeyStateGenerationKey('test'), '5');
    await expect(
      loadVerifiedLookupHmacKeyState({
        store: { get: async (key) => values.get(key) ?? null },
        environmentId: 'test',
        publicJwks: { keys: [publicJwk] },
        now: NOW,
      })
    ).rejects.toThrow('lookup_hmac_key_state_generation_mismatch');
  });
});
