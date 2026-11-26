import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  D1WrappedLoggingKeyMaterialBackend,
  ExternalLoggingKeyMaterialBackendStub,
  LoggingKeyMaterialBackendError,
  R2WrappedLoggingKeyMaterialBackend,
  buildLoggingKeyMaterialRef,
  parseLoggingKeyMaterialRef,
  unwrapLoggingKeyMaterial,
  wrapLoggingKeyMaterial,
  type LoggingKeyMaterialR2Bucket,
  type LoggingKeyMaterialSqlStore,
  type WrappedLoggingKeyMaterialEnvelope,
} from '../key-material-backend';

const rootKeyHex = 'ab'.repeat(32);
const MAX = 64 * 1024;
const scope = { tenantKey: 'tenant-a', logType: 'audit', plane: 'archive' } as const;
const material = {
  algorithm: 'AES-GCM',
  keyBytes: Uint8Array.from({ length: 32 }, (_, i) => i),
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

async function failure(promise: Promise<unknown>): Promise<LoggingKeyMaterialBackendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoggingKeyMaterialBackendError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function failureOf(run: () => unknown): LoggingKeyMaterialBackendError {
  try {
    run();
  } catch (error) {
    if (error instanceof LoggingKeyMaterialBackendError) return error;
    throw error;
  }
  throw new Error('expected a throw');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The AES-GCM key an HKDF-SHA-256 derivation of the root key gives, computed here independently. */
async function derivedKey(
  salt: string,
  info: string,
  usages: Array<'encrypt' | 'decrypt'>
): Promise<CryptoKey> {
  const root = Uint8Array.from({ length: 32 }, (_, i) =>
    Number.parseInt(rootKeyHex.slice(i * 2, i * 2 + 2), 16)
  );
  const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveKey']);
  const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encode(salt), info: encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

function mockRandom(byte: number): void {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(byte);
      return array;
    }
  );
}

const wrapOptions = {
  rootKeyHex,
  backend: 'd1_wrapped_key' as const,
  keyVersion: 2,
  backendRef: 'logkey:d1_wrapped_key:s:v1:k',
  scopeId: 's',
  version: 1,
};
const unwrapOptions = { rootKeyHex, backendRef: wrapOptions.backendRef, scopeId: 's', version: 1 };

describe('LoggingKeyMaterialBackendError', () => {
  it('carries its name, message, code and cause', () => {
    const cause = new Error('inner');
    const error = new LoggingKeyMaterialBackendError('msg', 'not_found', { cause });
    expect(error.name).toBe('LoggingKeyMaterialBackendError');
    expect(error.message).toBe('msg');
    expect(error.code).toBe('not_found');
    expect(error.cause).toBe(cause);
  });
});

describe('wrapLoggingKeyMaterial and unwrapLoggingKeyMaterial', () => {
  it('wraps with the key derived from the root key and binds the reference', async () => {
    const envelope = await wrapLoggingKeyMaterial(material, wrapOptions);
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      backend: 'd1_wrapped_key',
      keyVersion: 2,
      contentType: 'application/authrim.logging-key+json',
    });
    const key = await derivedKey('authrim-logging-key-material-root', 'authrim:d1_wrapped_key:v2', [
      'decrypt',
    ]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlToBytes(envelope.iv),
        additionalData: new TextEncoder().encode(
          '{"backend_ref":"logkey:d1_wrapped_key:s:v1:k","scope_id":"s","version":1}'
        ),
        tagLength: 128,
      },
      key,
      base64UrlToBytes(envelope.ciphertext)
    );
    const wrapped = JSON.parse(new TextDecoder().decode(plaintext)) as {
      algorithm: string;
      key_bytes: string;
    };
    expect(wrapped.algorithm).toBe('AES-GCM');
    expect(typeof wrapped.key_bytes).toBe('string');
    expect(base64UrlToBytes(envelope.iv)).toHaveLength(12);
  });

  it('reads back the key bytes it wrapped, whatever the IV bytes', async () => {
    for (const byte of [0xfb, 0xff, 0x00]) {
      mockRandom(byte);
      const envelope = await wrapLoggingKeyMaterial(material, wrapOptions);
      const back = await unwrapLoggingKeyMaterial(envelope, unwrapOptions);
      expect(back.algorithm).toBe('AES-GCM');
      expect([...back.keyBytes]).toEqual([...material.keyBytes]);
    }
  });

  it('writes URL-safe base64 without padding', async () => {
    mockRandom(0xfb);
    const plus = await wrapLoggingKeyMaterial(material, wrapOptions);
    expect(plus.iv).toBe('-_v7'.repeat(4));
    mockRandom(0xff);
    const slash = await wrapLoggingKeyMaterial(material, wrapOptions);
    expect(slash.iv).toBe('_'.repeat(16));
    for (const length of [1, 2, 3, 31, 32]) {
      const envelope = await wrapLoggingKeyMaterial(
        { algorithm: 'AES-GCM', keyBytes: new Uint8Array(length).fill(0xfb) },
        wrapOptions
      );
      expect(envelope.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
      const back = await unwrapLoggingKeyMaterial(envelope, unwrapOptions);
      expect([...back.keyBytes]).toEqual(Array.from({ length }, () => 0xfb));
    }
  });

  it('refuses a root key that is not 64 hex characters', async () => {
    for (const bad of [
      '',
      'ab'.repeat(31),
      'ab'.repeat(33),
      `g${'a'.repeat(63)}`,
      `${'a'.repeat(63)}g`,
      `${'a'.repeat(63)}!`,
      `!${'a'.repeat(63)}`,
    ]) {
      const error = await failure(
        wrapLoggingKeyMaterial(material, { ...wrapOptions, rootKeyHex: bad })
      );
      expect(error.code).toBe('encryption_failed');
      expect(error.message).toBe('logging_key_root_key_invalid');
    }
    await expect(
      wrapLoggingKeyMaterial(material, { ...wrapOptions, rootKeyHex: 'AbCdEf0123456789'.repeat(4) })
    ).resolves.toBeDefined();
  });

  it('reports a failed unwrap with its cause', async () => {
    const envelope = await wrapLoggingKeyMaterial(material, wrapOptions);
    const wrongs = [
      { ...unwrapOptions, rootKeyHex: 'cd'.repeat(32) },
      { ...unwrapOptions, backendRef: 'other' },
      { ...unwrapOptions, scopeId: 'other' },
      { ...unwrapOptions, version: 2 },
    ];
    for (const options of wrongs) {
      const error = await failure(unwrapLoggingKeyMaterial(envelope, options));
      expect(error.code).toBe('decryption_failed');
      expect(error.message).toBe('logging_key_material_decryption_failed');
      expect(error.cause).toBeInstanceOf(Error);
    }
    expect(
      (await failure(unwrapLoggingKeyMaterial({ ...envelope, keyVersion: 3 }, unwrapOptions))).code
    ).toBe('decryption_failed');
    expect(
      (
        await failure(
          unwrapLoggingKeyMaterial({ ...envelope, backend: 'r2_wrapped_key' }, unwrapOptions)
        )
      ).code
    ).toBe('decryption_failed');
  });

  it('refuses wrapped content that is not AES-GCM key bytes', async () => {
    for (const content of [
      { algorithm: 'AES-CBC', key_bytes: 'AAAA' },
      { algorithm: 'AES-GCM' },
      { algorithm: 'AES-GCM', key_bytes: '' },
    ]) {
      const key = await derivedKey(
        'authrim-logging-key-material-root',
        'authrim:d1_wrapped_key:v2',
        ['encrypt']
      );
      const iv = new Uint8Array(12).fill(7);
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: new TextEncoder().encode(
            '{"backend_ref":"logkey:d1_wrapped_key:s:v1:k","scope_id":"s","version":1}'
          ),
          tagLength: 128,
        },
        key,
        new TextEncoder().encode(JSON.stringify(content))
      );
      const toUrl = (bytes: Uint8Array): string =>
        btoa(String.fromCharCode(...bytes))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '');
      const envelope: WrappedLoggingKeyMaterialEnvelope = {
        version: 1,
        algorithm: 'AES-256-GCM',
        backend: 'd1_wrapped_key',
        keyVersion: 2,
        contentType: 'application/authrim.logging-key+json',
        iv: toUrl(iv),
        ciphertext: toUrl(new Uint8Array(ciphertext)),
      };
      const error = await failure(unwrapLoggingKeyMaterial(envelope, unwrapOptions));
      expect(error.code).toBe('decryption_failed');
      expect((error.cause as Error).message).toBe('invalid_logging_key_material_envelope');
    }
  });
});

describe('logging key material refs', () => {
  it('builds a ref with encoded scope and key ids', () => {
    expect(
      buildLoggingKeyMaterialRef({
        backend: 'r2_wrapped_key',
        scopeId: 'a/b',
        version: 3,
        keyId: 'x y',
      })
    ).toBe('logkey:r2_wrapped_key:a%2Fb:v3:x%20y');
  });

  it('parses every backend and decodes the ids', () => {
    for (const backend of ['r2_wrapped_key', 'd1_wrapped_key', 'external_kms']) {
      expect(parseLoggingKeyMaterialRef(`logkey:${backend}:a%2Fb:v12:x%20y`)).toStrictEqual({
        backend,
        scopeId: 'a/b',
        version: 12,
        keyId: 'x y',
      });
    }
  });

  it('refuses refs that are not logkey:backend:scope:v<n>:key', () => {
    for (const ref of [
      '',
      'logkey:d1_wrapped_key:s:v1',
      'xlogkey:d1_wrapped_key:s:v1:k',
      'logkey:d1_wrapped_key:s:v1:k:extra',
      'logkey:d1_wrapped_key:s:v0:k',
      'logkey:d1_wrapped_key:s:v01:k',
      'logkey:d1_wrapped_key:s:vx:k',
      'logkey:d1_wrapped_key:s:v1a:k',
      'logkey:d1_wrapped_key::v1:k',
    ]) {
      const error = failureOf(() => parseLoggingKeyMaterialRef(ref));
      expect(error.code).toBe('invalid_ref');
      expect(error.message).toBe('invalid_logging_key_material_ref');
    }
    expect(parseLoggingKeyMaterialRef('logkey:d1_wrapped_key:s:v10:k').version).toBe(10);
    expect(parseLoggingKeyMaterialRef('logkey:d1_wrapped_key:s:v9:k').version).toBe(9);
  });

  it('refuses an unknown backend', () => {
    const error = failureOf(() => parseLoggingKeyMaterialRef('logkey:nope:s:v1:k'));
    expect(error.code).toBe('invalid_ref');
    expect(error.message).toBe('unknown_logging_key_material_backend');
  });
});

describe('ExternalLoggingKeyMaterialBackendStub', () => {
  it('is unavailable for every operation', async () => {
    const stub = new ExternalLoggingKeyMaterialBackendStub();
    expect(stub.kind).toBe('external_kms');
    const calls = [
      stub.put({ scope, scopeId: 's', version: 1, material }),
      stub.get('logkey:external_kms:s:v1:k'),
      stub.delete('logkey:external_kms:s:v1:k'),
    ];
    for (const call of calls) {
      const error = await failure(call);
      expect(error.code).toBe('unavailable');
      expect(error.message).toBe('external_kms_backend_unavailable');
    }
  });
});

function sqlStore(rowsAffected: unknown = { rowsAffected: 0 }) {
  const rows = new Map<string, Record<string, unknown>>();
  const queryOne = vi.fn(async (_sql: string, params: unknown[] = []) => {
    return (rows.get(String(params[0])) ?? null) as never;
  });
  const execute = vi.fn(async (sql: string, params: unknown[] = []): Promise<unknown> => {
    if (sql.includes('INSERT INTO')) {
      rows.set(String(params[0]), {
        scope_id: params[1],
        version: params[6],
        envelope_json: params[7],
      });
    }
    if (sql.includes('UPDATE')) return rowsAffected;
    return undefined;
  });
  const store: LoggingKeyMaterialSqlStore = { queryOne, execute };
  return { store, rows, queryOne, execute };
}

describe('D1WrappedLoggingKeyMaterialBackend', () => {
  it('inserts a new wrapped key after an update that touched nothing', async () => {
    const { store, execute, rows } = sqlStore();
    const backend = new D1WrappedLoggingKeyMaterialBackend({ store, rootKeyHex, now: () => 5000 });
    const ref = await backend.put({
      scope: { ...scope, surface: 'admin' },
      scopeId: 'scope/1',
      version: 2,
      material,
    });
    expect(backend.kind).toBe('d1_wrapped_key');
    expect(ref).toBe('logkey:d1_wrapped_key:scope%2F1:v2:scope%2F1%2Fv2');
    expect(execute).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = must(execute.mock.calls[0]);
    expect(updateSql).toContain('UPDATE logging_key_material_bodies');
    expect(updateSql).toContain('WHERE backend_ref = ?');
    expect(updateParams.slice(1)).toEqual([5000, ref]);
    const [insertSql, insertParams] = must(execute.mock.calls[1]);
    expect(insertSql).toContain('INSERT INTO logging_key_material_bodies');
    expect(insertParams.slice(0, 7)).toEqual([
      ref,
      'scope/1',
      'tenant-a',
      'admin',
      'audit',
      'archive',
      2,
    ]);
    expect(insertParams.slice(8)).toEqual([5000, 5000]);
    expect(JSON.parse(String(insertParams[7]))).toMatchObject({
      backend: 'd1_wrapped_key',
      keyVersion: 1,
    });
    expect(JSON.parse(String(updateParams[0]))).toMatchObject({ backend: 'd1_wrapped_key' });
    expect(rows.size).toBe(1);
  });

  it('stores a missing surface as null, and uses the given time or the clock', async () => {
    const { store, execute } = sqlStore();
    const backend = new D1WrappedLoggingKeyMaterialBackend({ store, rootKeyHex, keyVersion: 4 });
    await backend.put({ scope, scopeId: 's', version: 1, material, now: 777 });
    expect(must(execute.mock.calls[1])[1].slice(3, 4)).toEqual([null]);
    expect(must(execute.mock.calls[1])[1].slice(8)).toEqual([777, 777]);
    expect(JSON.parse(String(must(execute.mock.calls[1])[1][7]))).toMatchObject({ keyVersion: 4 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(9999));
    const clocked = new D1WrappedLoggingKeyMaterialBackend({ store, rootKeyHex });
    await clocked.put({ scope, scopeId: 's', version: 2, material });
    expect(must(execute.mock.calls[3])[1].slice(8)).toEqual([9999, 9999]);
  });

  it('only updates when the row exists', async () => {
    const { store, execute } = sqlStore({ rowsAffected: 1 });
    const backend = new D1WrappedLoggingKeyMaterialBackend({ store, rootKeyHex, now: () => 5000 });
    const ref = await backend.put({ scope, scopeId: 's', version: 1, material });
    expect(ref).toBe('logkey:d1_wrapped_key:s:v1:s%2Fv1');
    expect(execute).toHaveBeenCalledTimes(1);
    for (const unknown of [undefined, null, {}, { rowsAffected: 'x' }, { rowsAffected: 0 }]) {
      const other = sqlStore(unknown);
      const again = new D1WrappedLoggingKeyMaterialBackend({ store: other.store, rootKeyHex });
      await again.put({ scope, scopeId: 's', version: 1, material });
      expect(other.execute).toHaveBeenCalledTimes(2);
    }
  });

  it('reads a key back and refuses refs of another backend', async () => {
    const { store, queryOne } = sqlStore();
    const backend = new D1WrappedLoggingKeyMaterialBackend({ store, rootKeyHex });
    const ref = await backend.put({ scope, scopeId: 's', version: 1, material });
    const back = must(await backend.get(ref));
    expect(back.algorithm).toBe('AES-GCM');
    expect([...back.keyBytes]).toEqual([...material.keyBytes]);
    const [sql, params] = must(queryOne.mock.calls[0]);
    expect(sql).toContain('FROM logging_key_material_bodies');
    expect(sql).toContain('WHERE backend_ref = ?');
    expect(params).toEqual([ref]);
    expect(await backend.get('logkey:d1_wrapped_key:s:v9:missing')).toBeNull();

    for (const call of [
      backend.get('logkey:r2_wrapped_key:s:v1:k'),
      backend.delete('logkey:r2_wrapped_key:s:v1:k'),
    ]) {
      const error = await failure(call);
      expect(error.code).toBe('invalid_ref');
      expect(error.message).toBe('logging_key_material_backend_mismatch');
    }
  });

  it('deletes by ref', async () => {
    const { store, execute } = sqlStore();
    const backend = new D1WrappedLoggingKeyMaterialBackend({ store, rootKeyHex });
    await backend.delete('logkey:d1_wrapped_key:s:v1:k');
    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM logging_key_material_bodies WHERE backend_ref = ?',
      ['logkey:d1_wrapped_key:s:v1:k']
    );
  });
});

function bucket() {
  const objects = new Map<string, string>();
  const put = vi.fn(async (key: string, value: unknown, _options?: unknown) => {
    objects.set(key, String(value));
  });
  const get = vi.fn(async (key: string) => {
    const value = objects.get(key);
    return value === undefined ? null : { body: new Response(value).body, text: async () => value };
  });
  const del = vi.fn(async (key: string) => {
    objects.delete(key);
  });
  return {
    bucket: { put, get, delete: del } as LoggingKeyMaterialR2Bucket,
    objects,
    put,
    get,
    del,
  };
}

describe('R2WrappedLoggingKeyMaterialBackend', () => {
  it('writes the wrapped key under a scope-keyed object with its metadata', async () => {
    const harness = bucket();
    const backend = new R2WrappedLoggingKeyMaterialBackend({
      bucket: harness.bucket,
      rootKeyHex,
      now: () => 5000,
    });
    const ref = await backend.put({ scope, scopeId: 'scope/1', version: 2, material });
    expect(backend.kind).toBe('r2_wrapped_key');
    const objectKey = 'logging-key-material/scope=scope%2F1/v2.json';
    expect(ref).toBe(
      'logkey:r2_wrapped_key:scope%2F1:v2:logging-keys%2Flogging-key-material%2Fscope%3Dscope%252F1%2Fv2.json'
    );
    const [key, body, options] = must(harness.put.mock.calls[0]);
    expect(key).toBe(objectKey);
    expect(JSON.parse(String(body))).toMatchObject({ backend: 'r2_wrapped_key', keyVersion: 1 });
    expect(options).toStrictEqual({
      httpMetadata: { contentType: 'application/authrim.logging-key+json' },
      customMetadata: {
        scopeId: 'scope/1',
        tenantKey: 'tenant-a',
        logType: 'audit',
        plane: 'archive',
        version: '2',
        createdAt: '5000',
      },
    });
  });

  it('uses the given authority, prefix, key version and time', async () => {
    const harness = bucket();
    const backend = new R2WrappedLoggingKeyMaterialBackend({
      bucket: harness.bucket,
      rootKeyHex,
      authority: 'auth',
      keyPrefix: 'pre',
      keyVersion: 3,
    });
    const ref = await backend.put({ scope, scopeId: 's', version: 1, material, now: 42 });
    expect(must(harness.put.mock.calls[0])[0]).toBe('pre/scope=s/v1.json');
    expect(JSON.parse(String(must(harness.put.mock.calls[0])[1]))).toMatchObject({ keyVersion: 3 });
    expect(must(harness.put.mock.calls[0])[2]).toMatchObject({
      customMetadata: { createdAt: '42' },
    });
    expect(parseLoggingKeyMaterialRef(ref).keyId).toBe('auth/pre/scope=s/v1.json');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(9999));
    const clocked = new R2WrappedLoggingKeyMaterialBackend({ bucket: harness.bucket, rootKeyHex });
    await clocked.put({ scope, scopeId: 's', version: 2, material });
    expect(must(harness.put.mock.calls[1])[2]).toMatchObject({
      customMetadata: { createdAt: '9999' },
    });
  });

  it('reads a key back, and refuses refs of another backend or authority', async () => {
    const harness = bucket();
    const backend = new R2WrappedLoggingKeyMaterialBackend({ bucket: harness.bucket, rootKeyHex });
    const ref = await backend.put({ scope, scopeId: 's', version: 1, material });
    const back = must(await backend.get(ref));
    expect([...back.keyBytes]).toEqual([...material.keyBytes]);
    expect(harness.get).toHaveBeenCalledWith('logging-key-material/scope=s/v1.json');
    expect(await backend.get('logkey:r2_wrapped_key:s:v1:logging-keys%2Fnothing')).toBeNull();

    for (const call of [
      backend.get('logkey:d1_wrapped_key:s:v1:k'),
      backend.delete('logkey:d1_wrapped_key:s:v1:k'),
    ]) {
      const error = await failure(call);
      expect(error.code).toBe('invalid_ref');
      expect(error.message).toBe('logging_key_material_backend_mismatch');
    }
    for (const call of [
      backend.get('logkey:r2_wrapped_key:s:v1:other%2Fx'),
      backend.delete('logkey:r2_wrapped_key:s:v1:other%2Fx'),
    ]) {
      const error = await failure(call);
      expect(error.code).toBe('invalid_ref');
      expect(error.message).toBe('logging_key_material_authority_mismatch');
    }
  });

  it('deletes the object of a ref', async () => {
    const harness = bucket();
    const backend = new R2WrappedLoggingKeyMaterialBackend({ bucket: harness.bucket, rootKeyHex });
    const ref = await backend.put({ scope, scopeId: 's', version: 1, material });
    await backend.delete(ref);
    expect(harness.del).toHaveBeenCalledWith('logging-key-material/scope=s/v1.json');
    expect(harness.objects.size).toBe(0);
  });

  describe('objects of any size', () => {
    async function envelopeText(padTo?: number): Promise<string> {
      const envelope = await wrapLoggingKeyMaterial(material, {
        ...wrapOptions,
        backend: 'r2_wrapped_key',
        backendRef: 'logkey:r2_wrapped_key:s:v1:logging-keys%2Fk',
        scopeId: 's',
        version: 1,
      });
      const text = JSON.stringify(envelope);
      return padTo === undefined
        ? text
        : text + ' '.repeat(padTo - new TextEncoder().encode(text).length);
    }
    const ref = 'logkey:r2_wrapped_key:s:v1:logging-keys%2Fk';

    function backendWith(object: unknown) {
      const harness = bucket();
      harness.get.mockResolvedValue(object as never);
      return new R2WrappedLoggingKeyMaterialBackend({ bucket: harness.bucket, rootKeyHex });
    }

    function streamOf(...chunks: Array<Uint8Array | undefined>) {
      const reads: Array<{ done: boolean; value?: Uint8Array }> = [
        ...chunks.map((value) => ({ done: false, value })),
        { done: true },
      ];
      const releaseLock = vi.fn();
      const cancel = vi.fn(async () => {});
      const getReader = vi.fn(() => ({
        read: async () => reads.shift() ?? { done: true },
        releaseLock,
        cancel,
      }));
      return { body: { getReader }, releaseLock, cancel, getReader };
    }

    it('reads a body in several chunks and releases the reader', async () => {
      const bytes = new TextEncoder().encode(await envelopeText());
      const third = Math.floor(bytes.length / 3);
      const stream = streamOf(
        bytes.slice(0, third),
        undefined,
        bytes.slice(third, 2 * third),
        bytes.slice(2 * third)
      );
      const found = await backendWith({ body: stream.body, text: async () => '' }).get(ref);
      expect([...must(found).keyBytes]).toEqual([...material.keyBytes]);
      expect(stream.releaseLock).toHaveBeenCalledTimes(1);
      expect(stream.cancel).not.toHaveBeenCalled();
    });

    it('accepts exactly the maximum size and refuses more', async () => {
      const exact = streamOf(new TextEncoder().encode(await envelopeText(MAX)));
      await expect(
        backendWith({ body: exact.body, text: async () => '' }).get(ref)
      ).resolves.toBeDefined();
      const over = streamOf(new TextEncoder().encode(await envelopeText(MAX + 1)));
      const error = await failure(backendWith({ body: over.body, text: async () => '' }).get(ref));
      expect(error.code).toBe('invalid_envelope');
      expect(error.message).toBe('Logging key material envelope exceeds maximum size.');
      expect(over.cancel).toHaveBeenCalledTimes(1);
      expect(over.releaseLock).toHaveBeenCalledTimes(1);
      const half = new Uint8Array(MAX / 2 + 1).fill(32);
      const split = streamOf(half, half);
      expect(
        (await failure(backendWith({ body: split.body, text: async () => '' }).get(ref))).code
      ).toBe('invalid_envelope');
    });

    it('refuses an object that says it is too large before reading it', async () => {
      const stream = streamOf(new TextEncoder().encode(await envelopeText()));
      const error = await failure(
        backendWith({ size: MAX + 1, body: stream.body, text: async () => '' }).get(ref)
      );
      expect(error.code).toBe('invalid_envelope');
      expect(stream.getReader).not.toHaveBeenCalled();
      const ok = streamOf(new TextEncoder().encode(await envelopeText()));
      await expect(
        backendWith({ size: MAX, body: ok.body, text: async () => '' }).get(ref)
      ).resolves.toBeDefined();
    });

    it('reads the text of an object without a body, bounded in bytes', async () => {
      const exact = await envelopeText(MAX);
      await expect(
        backendWith({ body: null, text: async () => exact }).get(ref)
      ).resolves.toBeDefined();
      const over = await envelopeText(MAX + 1);
      expect((await failure(backendWith({ text: async () => over }).get(ref))).code).toBe(
        'invalid_envelope'
      );
      const wide = `${await envelopeText()}${'あ'.repeat(MAX / 3)}`;
      expect(wide.length).toBeLessThan(MAX);
      expect((await failure(backendWith({ text: async () => wide }).get(ref))).code).toBe(
        'invalid_envelope'
      );
    });
  });
});
