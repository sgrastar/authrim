import { describe, expect, it, vi } from 'vitest';
import {
  decodeStoredLogChunkBody,
  decodeStoredLogChunkRecord,
  decryptLogChunkBody,
} from '../r2-chunk-reader';
import { encryptLogChunkBody, writeLogChunkToR2 } from '../r2-chunk-writer';
import type { LogChunkRecordIndexRow } from '../types';

const key32 = new Uint8Array(32).fill(5);
const context = {
  tenantKey: 't_1',
  logType: 'audit',
  plane: 'archive',
  objectKey: 'logs/x.bin',
  chunkId: 'chk_1',
} as const;
const scope = 'tenant:t_1:audit:archive';

async function sealed(
  plaintext: string,
  compression: 'none' | 'gzip_block' = 'none'
): Promise<string> {
  const body = await encryptLogChunkBody(new TextEncoder().encode(plaintext), {
    keyBytes: key32,
    encryptionScope: scope,
    keyVersion: 2,
    compression,
    ...context,
  });
  return new TextDecoder().decode(body);
}

function tampered(text: string, change: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), ...change });
}

const decrypt = (storedBody: Uint8Array | string, extra: Record<string, unknown> = {}) =>
  decryptLogChunkBody({ storedBody, keyBytes: key32, ...context, ...extra });

describe('decryptLogChunkBody', () => {
  it('opens a sealed body, from text or bytes, and reports how it was sealed', async () => {
    for (const compression of ['none', 'gzip_block'] as const) {
      const text = await sealed('plain text', compression);
      for (const stored of [text, new TextEncoder().encode(text)]) {
        const decoded = await decrypt(stored);
        expect(new TextDecoder().decode(decoded.body)).toBe('plain text');
        expect(decoded).toMatchObject({ compression, encryptionScope: scope, keyVersion: 2 });
      }
    }
  });

  it('opens bodies of every length, whatever padding their base64 needed', async () => {
    for (let length = 0; length < 12; length += 1) {
      const text = 'x'.repeat(length);
      expect(new TextDecoder().decode((await decrypt(await sealed(text))).body)).toBe(text);
    }
  });

  it('refuses a key that is not 32 bytes', async () => {
    const text = await sealed('x');
    for (const length of [0, 16, 31, 33]) {
      await expect(decrypt(text, { keyBytes: new Uint8Array(length) })).rejects.toThrow(
        'log_chunk_decryption_key_must_be_32_bytes'
      );
    }
  });

  it('refuses an envelope that is not complete and exactly what the writer makes', async () => {
    const text = await sealed('x');
    const invalid = 'invalid_log_chunk_encryption_envelope';
    const wrong: Array<Record<string, unknown>> = [
      { version: 2 },
      { version: undefined },
      { algorithm: 'AES-128-GCM' },
      { algorithm: undefined },
      { contentType: 'text/plain' },
      { contentType: undefined },
      { compression: 5 },
      { compression: undefined },
      { encryptionScope: 5 },
      { encryptionScope: undefined },
      { keyVersion: '2' },
      { keyVersion: undefined },
      { iv: 5 },
      { iv: undefined },
      { ciphertext: 5 },
      { ciphertext: undefined },
    ];
    for (const change of wrong) {
      await expect(decrypt(tampered(text, change))).rejects.toThrow(invalid);
    }
    await expect(decrypt(tampered(text, { keyVersion: 0, ciphertext: 'AA' }))).rejects.not.toThrow(
      invalid
    );
  });

  it('refuses a body sealed for another scope or key version, when one is expected', async () => {
    const text = await sealed('x');
    await expect(decrypt(text, { expectedEncryptionScope: 'other' })).rejects.toThrow(
      'log_chunk_encryption_scope_mismatch'
    );
    await expect(decrypt(text, { expectedKeyVersion: 1 })).rejects.toThrow(
      'log_chunk_key_version_mismatch'
    );
    await expect(decrypt(text, { expectedKeyVersion: 0 })).rejects.toThrow(
      'log_chunk_key_version_mismatch'
    );
    await expect(
      decrypt(text, { expectedEncryptionScope: scope, expectedKeyVersion: 2 })
    ).resolves.toBeDefined();
    await expect(
      decrypt(text, { expectedEncryptionScope: undefined, expectedKeyVersion: undefined })
    ).resolves.toBeDefined();
  });

  it('refuses a body opened with another key or another place in the store', async () => {
    const text = await sealed('x');
    await expect(decrypt(text, { keyBytes: new Uint8Array(32).fill(6) })).rejects.toThrow();
    for (const change of [
      { tenantKey: 't_2' },
      { logType: 'security' },
      { plane: 'primary' },
      { objectKey: 'logs/other.bin' },
      { chunkId: 'chk_2' },
    ]) {
      await expect(decrypt(text, change)).rejects.toThrow();
    }
    await expect(decrypt(tampered(text, { compression: 'gzip_block' }))).rejects.toThrow();
    await expect(decrypt(tampered(text, { encryptionScope: 'other' }))).rejects.toThrow();
    await expect(decrypt(tampered(text, { keyVersion: 9 }))).rejects.toThrow();
  });
});

describe('decodeStoredLogChunkBody', () => {
  it('returns a plaintext body as it is, whether text or bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(
      await decodeStoredLogChunkBody({ storedBody: bytes, compression: 'gzip_block' })
    ).toStrictEqual({
      body: bytes,
      compression: 'gzip_block',
    });
    const fromText = await decodeStoredLogChunkBody({ storedBody: 'abc', compression: 'none' });
    expect(fromText.body).toStrictEqual(new TextEncoder().encode('abc'));
    expect(fromText.compression).toBe('none');
    expect(fromText).not.toHaveProperty('encryptionScope');
  });

  it('opens an encrypted body with the compression it was sealed with, not the one asked for', async () => {
    const text = await sealed('secret', 'gzip_block');
    const decoded = await decodeStoredLogChunkBody({
      storedBody: text,
      compression: 'none',
      encryption: { keyBytes: key32, ...context },
    });
    expect(new TextDecoder().decode(decoded.body)).toBe('secret');
    expect(decoded.compression).toBe('gzip_block');
    expect(decoded.encryptionScope).toBe(scope);
  });
});

describe('decodeStoredLogChunkRecord', () => {
  async function written(options: { encrypted: boolean; compression: 'none' | 'gzip_block' }) {
    const put = vi.fn(async (_key: string, _body: unknown, _options?: unknown) => undefined);
    const indexes: LogChunkRecordIndexRow[] = [];
    const records = ['a', 'b', 'c', 'd'].map((id, i) => ({
      id,
      eventAt: i,
      payload: { id, text: 'y'.repeat(30) },
    }));
    const result = await writeLogChunkToR2({
      bucket: { put } as unknown as R2Bucket,
      tenantKey: 't_1',
      logType: 'audit',
      plane: 'archive',
      now: 1_700_000_000_000,
      chunkId: 'chk_1',
      objectCatalogId: 'obj_1',
      shard: 's00',
      compression: options.compression,
      records,
      ...(options.encrypted
        ? { encryption: { keyBytes: key32, encryptionScope: scope, keyVersion: 2 } }
        : { allowPlaintext: true }),
      catalogStore: {
        createPendingObject: async () => true,
        createPendingRecordIndexes: async (rows) => {
          indexes.push(...rows);
        },
        commitObject: async () => undefined,
        commitRecordIndexes: async () => undefined,
        markObjectOrphanCandidate: async () => undefined,
      },
    });
    return { body: put.mock.calls[0]?.[1] as Uint8Array, indexes, records, result };
  }

  it('reads each record back from what the writer stored, by its index row', async () => {
    for (const encrypted of [false, true]) {
      for (const compression of ['none', 'gzip_block'] as const) {
        const { body, indexes, records, result } = await written({ encrypted, compression });
        for (const [index, row] of indexes.entries()) {
          const decoded = await decodeStoredLogChunkRecord({
            storedBody: body,
            compression,
            recordIndex: row,
            ...(encrypted
              ? {
                  encryption: {
                    keyBytes: key32,
                    tenantKey: 't_1',
                    logType: 'audit' as const,
                    plane: 'archive' as const,
                    objectKey: result.objectKey,
                    chunkId: 'chk_1',
                  },
                }
              : {}),
          });
          expect(decoded).toEqual(records[index]?.payload);
        }
      }
    }
  });

  it('reads a whole plain chunk when the index row has no block offsets', async () => {
    const { body, indexes, records } = await written({ encrypted: false, compression: 'none' });
    const second = indexes[1];
    if (!second) throw new Error('expected an index row');
    const decoded = await decodeStoredLogChunkRecord({
      storedBody: body,
      compression: 'none',
      recordIndex: { ...second, blockOffset: undefined, blockLength: undefined },
    });
    expect(decoded).toEqual(records[1]?.payload);
    const nulls = await decodeStoredLogChunkRecord({
      storedBody: body,
      compression: 'none',
      recordIndex: { ...second, blockOffset: null, blockLength: null },
    });
    expect(nulls).toEqual(records[1]?.payload);
  });
});
