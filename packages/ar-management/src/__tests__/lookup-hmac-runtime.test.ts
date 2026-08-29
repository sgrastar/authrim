import {
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  fingerprintLookupHmacKey,
  signLookupHmacKeyState,
  type Env,
} from '@authrim/ar-lib-core';
import { exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadLookupHmacRuntimeKeys,
  resetLookupHmacRuntimeKeyCacheForTest,
} from '../lookup-hmac-runtime';

const NOW_MS = 1_800_000_000_000;
const KEY_A = 'runtime-key-a-0123456789abcdef0123456789abcdef';
const KEY_B = 'runtime-key-b-0123456789abcdef0123456789abcdef';

describe('Lookup HMAC runtime key loader', () => {
  beforeEach(() => resetLookupHmacRuntimeKeyCacheForTest());

  async function env(options: { tamper?: boolean; fingerprintMismatch?: boolean } = {}) {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid: 'registry-key-a',
      alg: 'EdDSA',
    };
    const publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'registry-key-a',
      alg: 'EdDSA',
    };
    const token = await signLookupHmacKeyState({
      state: {
        environmentId: 'test',
        generation: 3,
        issuedAt: NOW_MS / 1000 - 1,
        expiresAt: NOW_MS / 1000 + 3600,
        rotationState: 'activation_dual_write',
        writeMode: 'dual_write',
        current: {
          generation: 2,
          keyId: 'lookup-key-2',
          slot: 'B',
          fingerprint: await fingerprintLookupHmacKey(KEY_B),
        },
        previous: {
          generation: 1,
          keyId: 'lookup-key-1',
          slot: 'A',
          fingerprint: options.fingerprintMismatch
            ? 'a'.repeat(64)
            : await fingerprintLookupHmacKey(KEY_A),
        },
      },
      privateJwk,
    });
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload.startsWith('e') ? 'f' : 'e'}${payload.slice(1)}.${signature}`;
    const values = new Map([
      [buildLookupHmacKeyStateSnapshotKey('test'), options.tamper ? tampered : token],
      [buildLookupHmacKeyStateGenerationKey('test'), '3'],
    ]);
    return {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => values.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      LOOKUP_HMAC_KEY_SLOT_A: KEY_A,
      LOOKUP_HMAC_KEY_SLOT_B: KEY_B,
    } as unknown as Env;
  }

  it('loads signed current/previous keys and honors dual-write mode', async () => {
    const result = await loadLookupHmacRuntimeKeys(await env(), { nowMs: NOW_MS });
    expect(result.readKeys.map((key) => key.generation)).toEqual([2, 1]);
    expect(result.writeKeys.map((key) => key.generation)).toEqual([2, 1]);
  });

  it('fails closed for tampering, local fingerprint mismatch, or missing signed state', async () => {
    await expect(
      loadLookupHmacRuntimeKeys(await env({ tamper: true }), {
        nowMs: NOW_MS,
        bypassCache: true,
      })
    ).rejects.toThrow('lookup_hmac_key_state_signature_invalid');
    await expect(
      loadLookupHmacRuntimeKeys(await env({ fingerprintMismatch: true }), {
        nowMs: NOW_MS,
        bypassCache: true,
      })
    ).rejects.toThrow('lookup_hmac_key_state_local_key_mismatch');
    await expect(
      loadLookupHmacRuntimeKeys({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, {
        nowMs: NOW_MS,
        bypassCache: true,
      })
    ).rejects.toThrow('lookup_hmac_key_state_unavailable');
  });

  it('coalesces concurrent cache misses into one verified registry read', async () => {
    const runtimeEnv = await env();
    const store = runtimeEnv.TENANT_RUNTIME_REGISTRY!;
    const originalGet = store.get.bind(store);
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let calls = 0;
    runtimeEnv.TENANT_RUNTIME_REGISTRY = {
      get: async (...args: Parameters<typeof store.get>) => {
        calls += 1;
        if (calls === 1) await firstRead;
        return originalGet(...args);
      },
    } as typeof store;

    const first = loadLookupHmacRuntimeKeys(runtimeEnv, { nowMs: NOW_MS });
    await Promise.resolve();
    const second = loadLookupHmacRuntimeKeys(runtimeEnv, { nowMs: NOW_MS });
    releaseFirstRead();

    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(calls).toBe(2);
  });

  it('maps registry transport failures to a stable diagnostic code', async () => {
    const runtimeEnv = await env();
    runtimeEnv.TENANT_RUNTIME_REGISTRY = {
      get: async () => {
        throw new Error('provider response contained sensitive details');
      },
    } as unknown as Env['TENANT_RUNTIME_REGISTRY'];

    await expect(
      loadLookupHmacRuntimeKeys(runtimeEnv, { nowMs: NOW_MS, bypassCache: true })
    ).rejects.toThrow('lookup_hmac_key_state_load_failed');
  });
});
