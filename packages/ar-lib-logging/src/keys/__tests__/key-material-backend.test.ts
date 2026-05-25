import { describe, expect, it } from 'vitest';
import {
  D1WrappedLoggingKeyMaterialBackend,
  ExternalLoggingKeyMaterialBackendStub,
  LoggingKeyMaterialBackendError,
  R2WrappedLoggingKeyMaterialBackend,
  buildLoggingKeyMaterialRef,
  parseLoggingKeyMaterialRef,
} from '../key-material-backend';

const rootKeyHex = 'b'.repeat(64);

class InMemoryLoggingKeyMaterialStore {
  readonly rows = new Map<string, Record<string, unknown>>();

  async queryOne<T>(_sql: string, params: unknown[] = []): Promise<T | null> {
    const row = this.rows.get(String(params[0]));
    return row ? ({ ...row } as T) : null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.includes('INSERT INTO logging_key_material_bodies')) {
      this.rows.set(String(params[0]), {
        backend_ref: params[0],
        scope_id: params[1],
        tenant_key: params[2],
        surface: params[3],
        log_type: params[4],
        plane: params[5],
        version: params[6],
        envelope_json: params[7],
        created_at: params[8],
        updated_at: params[9],
      });
      return;
    }
    if (sql.includes('DELETE FROM logging_key_material_bodies')) {
      this.rows.delete(String(params[0]));
    }
  }
}

class InMemoryLoggingKeyMaterialR2Bucket {
  readonly objects = new Map<string, string>();
  readonly metadata = new Map<string, Record<string, string>>();

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { customMetadata?: Record<string, string> }
  ): Promise<void> {
    if (typeof value !== 'string') {
      throw new Error('test bucket only supports string values');
    }
    this.objects.set(key, value);
    this.metadata.set(key, options?.customMetadata ?? {});
  }

  async get(
    key: string
  ): Promise<{ body: ReadableStream<Uint8Array> | null; text(): Promise<string> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }
    return {
      body: new Response(value).body,
      async text() {
        throw new Error('text fallback should not be used when stream body is available');
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

describe('logging key material backend refs', () => {
  it('round-trips wrapped key backend refs without exposing key material', () => {
    const ref = buildLoggingKeyMaterialRef({
      backend: 'r2_wrapped_key',
      scopeId: 'tk_abc:audit:archive',
      version: 3,
      keyId: 'key/current',
    });

    expect(ref).toBe('logkey:r2_wrapped_key:tk_abc%3Aaudit%3Aarchive:v3:key%2Fcurrent');
    expect(parseLoggingKeyMaterialRef(ref)).toEqual({
      backend: 'r2_wrapped_key',
      scopeId: 'tk_abc:audit:archive',
      version: 3,
      keyId: 'key/current',
    });
  });

  it('rejects malformed refs', () => {
    expect(() => parseLoggingKeyMaterialRef('r2://secret')).toThrow(LoggingKeyMaterialBackendError);
    expect(() => parseLoggingKeyMaterialRef('logkey:unknown:scope:v1:key')).toThrow(
      'unknown_logging_key_material_backend'
    );
  });

  it('keeps external KMS unavailable until a real provider is configured', async () => {
    const backend = new ExternalLoggingKeyMaterialBackendStub();

    await expect(
      backend.put({
        scope: { tenantKey: 'tk_abc', logType: 'audit', plane: 'archive' },
        scopeId: 'tk_abc:audit:archive',
        version: 1,
        material: { keyBytes: new Uint8Array(32), algorithm: 'AES-GCM' },
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('stores D1 wrapped key material without plaintext bytes', async () => {
    const store = new InMemoryLoggingKeyMaterialStore();
    const backend = new D1WrappedLoggingKeyMaterialBackend({
      store,
      rootKeyHex,
      now: () => 1779148800000,
    });
    const keyBytes = new Uint8Array(32).fill(7);

    const ref = await backend.put({
      scope: { tenantKey: 'tk_abc', logType: 'audit', plane: 'archive' },
      scopeId: 'tk_abc:audit:archive',
      version: 1,
      material: { keyBytes, algorithm: 'AES-GCM' },
    });

    expect(ref).toBe(
      'logkey:d1_wrapped_key:tk_abc%3Aaudit%3Aarchive:v1:tk_abc%3Aaudit%3Aarchive%2Fv1'
    );
    expect(JSON.stringify(store.rows.get(ref))).not.toContain(
      'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'
    );
    await expect(backend.get(ref)).resolves.toEqual({
      algorithm: 'AES-GCM',
      keyBytes,
    });

    await backend.delete(ref);
    await expect(backend.get(ref)).resolves.toBeNull();
  });

  it('stores R2 wrapped key material as encrypted objects', async () => {
    const bucket = new InMemoryLoggingKeyMaterialR2Bucket();
    const backend = new R2WrappedLoggingKeyMaterialBackend({
      bucket,
      rootKeyHex,
      now: () => 1779148800000,
    });
    const keyBytes = new Uint8Array(32).fill(9);

    const ref = await backend.put({
      scope: { tenantKey: 'tk_abc', surface: 'webhook', logType: 'webhook', plane: 'archive' },
      scopeId: 'tk_abc:webhook:webhook:archive',
      version: 2,
      material: { keyBytes, algorithm: 'AES-GCM' },
    });
    const parsed = parseLoggingKeyMaterialRef(ref);
    expect(parsed.backend).toBe('r2_wrapped_key');
    expect(parsed.keyId).toContain('logging-key-material/');

    const objectKey = parsed.keyId.replace('logging-keys/', '');
    expect(bucket.objects.get(objectKey)).not.toContain(
      'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk'
    );
    expect(bucket.metadata.get(objectKey)).toMatchObject({
      tenantKey: 'tk_abc',
      logType: 'webhook',
      plane: 'archive',
      version: '2',
    });
    await expect(backend.get(ref)).resolves.toEqual({
      algorithm: 'AES-GCM',
      keyBytes,
    });
  });

  it('rejects oversized R2 wrapped key material streams', async () => {
    const bucket = new InMemoryLoggingKeyMaterialR2Bucket();
    const backend = new R2WrappedLoggingKeyMaterialBackend({
      bucket,
      rootKeyHex,
      now: () => 1779148800000,
    });
    const objectKey = 'logging-key-material/scope=tk_abc%3Awebhook/v1.json';
    bucket.objects.set(objectKey, 'x'.repeat(64 * 1024 + 1));
    const ref = buildLoggingKeyMaterialRef({
      backend: 'r2_wrapped_key',
      scopeId: 'tk_abc:webhook',
      version: 1,
      keyId: `logging-keys/${objectKey}`,
    });

    await expect(backend.get(ref)).rejects.toMatchObject({
      code: 'invalid_envelope',
    });
  });
});
