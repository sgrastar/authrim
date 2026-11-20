import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, sha256Base64Url, type JsonValue } from '../core';
import {
  decryptCloudflareAgentJson,
  encryptCloudflareAgentJson,
} from '../platform/cloudflare/elevation';
import { keys } from './helpers/mut-routes-elevation-fixtures';

const aad = { purpose: 'test', tenant_id: 'tenant-1' };
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

afterEach(() => {
  vi.restoreAllMocks();
});

async function envelopeFor(value: JsonValue = { a: 1 }): Promise<Record<string, unknown>> {
  return JSON.parse(await encryptCloudflareAgentJson(value, keys, 'key-v1', aad)) as Record<
    string,
    unknown
  >;
}

describe('encryptCloudflareAgentJson', () => {
  it('produces a versioned A256GCM envelope bound to the AAD digest', async () => {
    const envelope = await envelopeFor({ b: 2, a: 1 });
    expect(Object.keys(envelope)).toEqual(['v', 'kid', 'alg', 'aad_digest', 'iv', 'ciphertext']);
    expect(envelope).toMatchObject({
      v: 1,
      kid: 'key-v1',
      alg: 'A256GCM',
      aad_digest: await sha256Base64Url(canonicalizeJson(aad)),
    });
    expect(envelope.iv).toMatch(/^[A-Za-z0-9_-]{16}$/u);
    await expect(decryptCloudflareAgentJson(JSON.stringify(envelope), keys, aad)).resolves.toEqual({
      a: 1,
      b: 2,
    });
  });

  it('encodes iv and ciphertext as unpadded base64url even when bytes map to + and /', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0xfb);
        return array;
      }
    );
    // 0xfb bytes encode to "+/v7" in standard base64.
    for (const value of ['', 'a', 'ab', { k: 'value-with-length' }] as JsonValue[]) {
      const envelope = await envelopeFor(value);
      expect(envelope.iv).toBe('-_v7-_v7-_v7-_v7');
      expect(envelope.ciphertext).toMatch(BASE64URL);
      await expect(
        decryptCloudflareAgentJson(JSON.stringify(envelope), keys, aad)
      ).resolves.toEqual(value);
    }
  });

  it('enforces the 64 KiB plaintext limit at the exact boundary', async () => {
    // A JSON string adds two quote bytes.
    const atLimit = 'a'.repeat(64 * 1024 - 2);
    await expect(
      decryptCloudflareAgentJson(
        await encryptCloudflareAgentJson(atLimit, keys, 'key-v1', aad),
        keys,
        aad
      )
    ).resolves.toBe(atLimit);
    await expect(encryptCloudflareAgentJson(`${atLimit}a`, keys, 'key-v1', aad)).rejects.toThrow(
      new TypeError('Agent elevation payload exceeds the encrypted payload limit')
    );
  });
});

describe('decryptCloudflareAgentJson', () => {
  it.each([
    ['null', () => null],
    ['array', () => []],
    ['string', () => 'x'],
    ['wrong version', (e: Record<string, unknown>) => ({ ...e, v: 2 })],
    ['wrong alg', (e: Record<string, unknown>) => ({ ...e, alg: 'A128GCM' })],
    ['numeric kid', (e: Record<string, unknown>) => ({ ...e, kid: 1 })],
    ['missing aad digest', (e: Record<string, unknown>) => ({ ...e, aad_digest: undefined })],
    ['numeric iv', (e: Record<string, unknown>) => ({ ...e, iv: 12 })],
    ['missing ciphertext', (e: Record<string, unknown>) => ({ ...e, ciphertext: null })],
  ])('rejects a %s envelope', async (_name, mutate) => {
    const envelope = await envelopeFor();
    await expect(
      decryptCloudflareAgentJson(JSON.stringify(mutate(envelope)), keys, aad)
    ).rejects.toThrow(new TypeError('Invalid Agent elevation payload envelope'));
  });

  it('rejects an envelope whose AAD context differs', async () => {
    const envelope = await envelopeFor();
    await expect(
      decryptCloudflareAgentJson(JSON.stringify(envelope), keys, { ...aad, tenant_id: 'other' })
    ).rejects.toThrow(new TypeError('Agent elevation payload context mismatch'));
  });

  it('looks up the decryption key by the envelope key id', async () => {
    const envelope = await envelopeFor();
    const getEncryptionKey = vi.fn(keys.getEncryptionKey);
    await decryptCloudflareAgentJson(
      JSON.stringify({ ...envelope, kid: 'key-v0' }),
      { ...keys, getEncryptionKey },
      aad
    );
    expect(getEncryptionKey).toHaveBeenCalledWith('key-v0');
  });

  it.each([
    ['empty iv', { iv: '' }],
    ['iv with leading +', { iv: '+AAAAAAAAAAAAAAA' }],
    ['iv with trailing =', { iv: 'AAAAAAAAAAAAAAA=' }],
    ['ciphertext with /', { ciphertext: 'AAAA/AAAA' }],
    ['ciphertext with inner space', { ciphertext: 'AAAA AAAA' }],
  ])('rejects %s as an invalid encoding', async (_name, patch) => {
    const envelope = await envelopeFor();
    await expect(
      decryptCloudflareAgentJson(JSON.stringify({ ...envelope, ...patch }), keys, aad)
    ).rejects.toThrow(new TypeError('Invalid encrypted payload encoding'));
  });
});
