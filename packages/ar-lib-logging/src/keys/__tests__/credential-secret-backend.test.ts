import { describe, expect, it } from 'vitest';

import {
  CredentialSecretBackendError,
  D1EncryptedCredentialSecretBackend,
  ExternalCredentialSecretManagerStub,
  R2EncryptedCredentialSecretBackend,
  assertCredentialRefVersion,
  buildCredentialSecretRef,
  parseCredentialSecretRef,
} from '../index';

const rootKeyHex = 'a'.repeat(64);

class InMemoryCredentialSecretStore {
  readonly bodies = new Map<string, Record<string, unknown>>();
  readonly metadata = new Map<string, Record<string, unknown>>();

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    if (sql.includes('FROM credential_secret_bodies')) {
      const credentialRef = String(params[0]);
      const body = this.bodies.get(credentialRef);
      if (!body) {
        return null;
      }
      return {
        ...body,
        metadata: this.metadata.get(credentialRef)?.metadata ?? null,
        status: this.metadata.get(credentialRef)?.status ?? null,
      } as T;
    }
    return null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.includes('INSERT INTO credential_secret_bodies')) {
      this.bodies.set(String(params[0]), {
        credential_ref: params[0],
        destination_id: params[1],
        version: params[2],
        envelope_json: params[3],
        created_at: params[4],
        updated_at: params[5],
      });
      return;
    }
    if (sql.includes('INSERT INTO credential_secret_metadata')) {
      this.metadata.set(String(params[0]), {
        credential_ref: params[0],
        destination_id: params[1],
        backend: params[2],
        version: params[3],
        status: params[4],
        created_at: params[5],
        retired_at: params[6],
        metadata: params[7],
      });
      return;
    }
    if (sql.includes("SET status = 'retired'")) {
      const credentialRef = String(params[1]);
      const row = this.metadata.get(credentialRef);
      if (row) {
        row.status = 'retired';
        row.retired_at = params[0];
      }
      return;
    }
    if (sql.includes("SET status = 'deleted'")) {
      const credentialRef = String(params[1]);
      const row = this.metadata.get(credentialRef);
      if (row) {
        row.status = 'deleted';
        row.retired_at = params[0];
      }
      return;
    }
    if (sql.includes('DELETE FROM credential_secret_bodies')) {
      this.bodies.delete(String(params[0]));
    }
  }
}

class InMemoryCredentialSecretR2Bucket {
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

describe('credential secret backend contracts', () => {
  it('builds and parses URI credential refs', () => {
    const ref = buildCredentialSecretRef({
      scheme: 'r2secret',
      authority: 'admin-secrets',
      path: 'destinations/dest_123/credentials/current',
      version: 3,
    });

    expect(ref).toBe('r2secret://admin-secrets/destinations/dest_123/credentials/current#v3');
    expect(parseCredentialSecretRef(ref)).toEqual({
      scheme: 'r2secret',
      authority: 'admin-secrets',
      path: '/destinations/dest_123/credentials/current',
      version: 3,
    });
  });

  it('rejects unsupported credential ref schemes', () => {
    expect(() => parseCredentialSecretRef('file:///tmp/secret')).toThrow(
      CredentialSecretBackendError
    );
  });

  it('asserts credential ref versions when a version is present', () => {
    const ref = 'd1secret://admin/credential_secrets/sec_abc#v1';

    expect(() => assertCredentialRefVersion(ref, 1)).not.toThrow();
    expect(() => assertCredentialRefVersion(ref, 2)).toThrow(CredentialSecretBackendError);
  });

  it('keeps the external manager as an explicit unavailable stub', async () => {
    const backend = new ExternalCredentialSecretManagerStub();

    await expect(
      backend.putSecret({
        destinationId: 'dest_1',
        version: 1,
        plaintext: 'secret',
      })
    ).rejects.toMatchObject({
      code: 'backend_unavailable',
    });
  });

  it('stores D1 credential secrets as encrypted envelopes and metadata only', async () => {
    const store = new InMemoryCredentialSecretStore();
    const backend = new D1EncryptedCredentialSecretBackend({
      store,
      rootKeyHex,
      now: () => 1779148800000,
    });

    const ref = await backend.putSecret({
      destinationId: 'dest_1',
      version: 1,
      plaintext: 'super-secret-token',
      metadata: {
        contentType: 'text/plain',
        labels: { provider: 'http' },
      },
    });

    expect(ref).toBe('d1secret://admin/credential_secrets/dest_1/v1#v1');
    expect(store.metadata.get(ref)).toMatchObject({
      backend: 'd1_encrypted_table',
      status: 'active',
      version: 1,
    });
    expect(JSON.stringify(store.bodies.get(ref))).not.toContain('super-secret-token');

    await expect(backend.getSecret(ref, 1)).resolves.toMatchObject({
      plaintext: 'super-secret-token',
      metadata: {
        destinationId: 'dest_1',
        version: 1,
        labels: { provider: 'http' },
      },
    });
  });

  it('rotates, retires, and deletes D1 credential secrets', async () => {
    const store = new InMemoryCredentialSecretStore();
    const backend = new D1EncryptedCredentialSecretBackend({
      store,
      rootKeyHex,
      now: () => 1779148800000,
    });
    const activeRef = await backend.putSecret({
      destinationId: 'dest_1',
      version: 1,
      plaintext: 'active-secret',
    });
    const nextRef = await backend.rotateSecret({
      destinationId: 'dest_1',
      nextVersion: 2,
      nextPlaintext: 'next-secret',
    });

    expect(store.metadata.get(nextRef)).toMatchObject({
      status: 'next',
      version: 2,
    });

    await backend.retireSecret(activeRef);
    expect(store.metadata.get(activeRef)).toMatchObject({
      status: 'retired',
      retired_at: 1779148800000,
    });

    await backend.deleteSecret(nextRef);
    expect(store.metadata.get(nextRef)).toMatchObject({
      status: 'deleted',
      retired_at: 1779148800000,
    });
    expect(store.bodies.has(nextRef)).toBe(false);
    await expect(backend.getSecret(nextRef, 2)).rejects.toMatchObject({
      code: 'secret_not_found',
    });
  });

  it('stores R2 credential secrets as encrypted objects with optional metadata rows', async () => {
    const bucket = new InMemoryCredentialSecretR2Bucket();
    const store = new InMemoryCredentialSecretStore();
    const backend = new R2EncryptedCredentialSecretBackend({
      bucket,
      metadataStore: store,
      rootKeyHex,
      now: () => 1779148800000,
    });

    const ref = await backend.putSecret({
      destinationId: 'dest_1',
      version: 3,
      plaintext: 'r2-secret-token',
      metadata: {
        contentType: 'application/json',
      },
    });

    expect(ref).toBe('r2secret://admin-secrets/destinations/dest_1/credentials/v3.json#v3');
    const objectKey = 'destinations/dest_1/credentials/v3.json';
    expect(bucket.objects.get(objectKey)).not.toContain('r2-secret-token');
    expect(bucket.metadata.get(objectKey)).toMatchObject({
      credential_ref: ref,
      destination_id: 'dest_1',
      version: '3',
    });
    expect(store.metadata.get(ref)).toMatchObject({
      backend: 'r2_encrypted_object',
      status: 'active',
      version: 3,
    });

    await expect(backend.getSecret(ref, 3)).resolves.toMatchObject({
      plaintext: 'r2-secret-token',
      metadata: {
        destinationId: 'dest_1',
        version: 3,
      },
    });
  });

  it('sanitizes R2 credential secret destination id path segments', async () => {
    const bucket = new InMemoryCredentialSecretR2Bucket();
    const backend = new R2EncryptedCredentialSecretBackend({
      bucket,
      rootKeyHex,
      now: () => 1779148800000,
    });

    const ref = await backend.putSecret({
      destinationId: 'dest_1/../../raw',
      version: 1,
      plaintext: 'r2-secret-token',
    });

    expect(ref).toBe(
      'r2secret://admin-secrets/destinations/dest_1_.._.._raw/credentials/v1.json#v1'
    );
    expect([...bucket.objects.keys()]).toEqual([
      'destinations/dest_1_.._.._raw/credentials/v1.json',
    ]);
  });

  it('rejects R2 credential refs for a different authority', async () => {
    const bucket = new InMemoryCredentialSecretR2Bucket();
    const backend = new R2EncryptedCredentialSecretBackend({
      bucket,
      rootKeyHex,
      now: () => 1779148800000,
    });

    await expect(
      backend.getSecret('r2secret://other-secrets/destinations/dest_1/credentials/v1.json#v1')
    ).rejects.toMatchObject({
      code: 'invalid_credential_ref',
    });
  });

  it('rejects oversized R2 credential secret streams', async () => {
    const bucket = new InMemoryCredentialSecretR2Bucket();
    const backend = new R2EncryptedCredentialSecretBackend({
      bucket,
      rootKeyHex,
      now: () => 1779148800000,
    });
    const objectKey = 'destinations/dest_1/credentials/v1.json';
    bucket.objects.set(objectKey, 'x'.repeat(64 * 1024 + 1));

    await expect(
      backend.getSecret('r2secret://admin-secrets/destinations/dest_1/credentials/v1.json#v1')
    ).rejects.toMatchObject({
      code: 'invalid_secret_envelope',
    });
  });

  it('deletes R2 credential objects and marks metadata deleted', async () => {
    const bucket = new InMemoryCredentialSecretR2Bucket();
    const store = new InMemoryCredentialSecretStore();
    const backend = new R2EncryptedCredentialSecretBackend({
      bucket,
      metadataStore: store,
      rootKeyHex,
      now: () => 1779148800000,
    });
    const ref = await backend.putSecret({
      destinationId: 'dest_1',
      version: 1,
      plaintext: 'r2-secret-token',
    });

    await backend.deleteSecret(ref);

    expect(bucket.objects.size).toBe(0);
    expect(store.metadata.get(ref)).toMatchObject({
      status: 'deleted',
      retired_at: 1779148800000,
    });
    await expect(backend.getSecret(ref, 1)).rejects.toMatchObject({
      code: 'secret_not_found',
    });
  });
});
