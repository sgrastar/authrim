import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialSecretBackendError,
  D1EncryptedCredentialSecretBackend,
  ExternalCredentialSecretManagerStub,
  R2EncryptedCredentialSecretBackend,
  type CredentialSecretR2Bucket,
  type CredentialSecretSqlStore,
} from '../credential-secret-backend';

const rootKeyHex = 'ab'.repeat(32);

afterEach(() => {
  vi.useRealTimers();
});

async function failure(promise: Promise<unknown>): Promise<CredentialSecretBackendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CredentialSecretBackendError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function sqlStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const queryOne = vi.fn(async (_sql: string, params: unknown[] = []) => {
    return (rows.get(String(params[0])) ?? null) as never;
  });
  const execute = vi.fn(async (_sql: string, _params: unknown[] = []) => undefined);
  const store: CredentialSecretSqlStore = { queryOne, execute };
  return { store, rows, queryOne, execute };
}

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
  return { bucket: { put, get, delete: del } as CredentialSecretR2Bucket, objects, put, get, del };
}

describe('D1EncryptedCredentialSecretBackend', () => {
  function d1(options: { authority?: string; keyVersion?: number; now?: () => number } = {}) {
    const harness = sqlStore();
    const backend = new D1EncryptedCredentialSecretBackend({
      store: harness.store,
      rootKeyHex,
      ...options,
    });
    return { backend, ...harness };
  }

  it('stores the body and the metadata of a secret with defaults', async () => {
    const { backend, execute } = d1({ now: () => 5000 });
    const ref = await backend.putSecret({ destinationId: 'dest_1', version: 3, plaintext: 'pw' });

    expect(ref).toBe('d1secret://admin/credential_secrets/dest_1/v3#v3');
    expect(backend.kind).toBe('d1_encrypted_table');
    expect(execute).toHaveBeenCalledTimes(2);
    const [bodySql, bodyParams] = must(execute.mock.calls[0]);
    expect(bodySql).toContain('INSERT INTO credential_secret_bodies');
    expect(bodyParams.slice(0, 3)).toEqual([ref, 'dest_1', 3]);
    expect(bodyParams.slice(4)).toEqual([5000, 5000]);
    const envelope = JSON.parse(String(bodyParams[3])) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      backend: 'd1_encrypted_table',
      keyVersion: 1,
      contentType: 'text/plain',
    });
    const [metaSql, metaParams] = must(execute.mock.calls[1]);
    expect(metaSql).toContain('INSERT INTO credential_secret_metadata');
    expect(metaParams.slice(0, 7)).toEqual([
      ref,
      'dest_1',
      'd1_encrypted_table',
      3,
      'active',
      5000,
      null,
    ]);
    expect(JSON.parse(String(metaParams[7]))).toEqual({
      destinationId: 'dest_1',
      version: 3,
      status: 'active',
      contentType: 'text/plain',
      createdAt: 5000,
    });
  });

  it('uses the given authority, key version, status, content type and creation time', async () => {
    const { backend, execute } = d1({ authority: 'custom', keyVersion: 4, now: () => 5000 });
    const ref = await backend.putSecret({
      destinationId: 'dest_1',
      version: 1,
      plaintext: 'pw',
      metadata: {
        status: 'next',
        contentType: 'application/json',
        createdAt: 12,
        rotatedAt: 13,
        retireAfter: 14,
        labels: { a: 'b' },
      },
    });
    expect(ref).toBe('d1secret://custom/credential_secrets/dest_1/v1#v1');
    const envelope = JSON.parse(String(must(execute.mock.calls[0])[1][3])) as Record<
      string,
      unknown
    >;
    expect(envelope).toMatchObject({ keyVersion: 4, contentType: 'application/json' });
    const metaParams = must(execute.mock.calls[1])[1];
    expect(metaParams.slice(4, 7)).toEqual(['next', 12, null]);
    expect(JSON.parse(String(metaParams[7]))).toEqual({
      destinationId: 'dest_1',
      version: 1,
      status: 'next',
      contentType: 'application/json',
      createdAt: 12,
      rotatedAt: 13,
      retireAfter: 14,
      labels: { a: 'b' },
    });
  });

  it('reads the clock for creation time by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(7777));
    const { backend, execute } = d1();
    await backend.putSecret({ destinationId: 'dest_1', version: 1, plaintext: 'pw' });
    expect(must(execute.mock.calls[1])[1][5]).toBe(7777);
  });

  it('reads a secret back with its stored metadata', async () => {
    const { backend, rows, queryOne, execute } = d1({ now: () => 5000 });
    execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INTO credential_secret_bodies')) {
        rows.set(String(params[0]), {
          destination_id: params[1],
          version: String(params[2]),
          envelope_json: params[3],
          metadata: null,
          status: null,
        });
      }
      if (sql.includes('INTO credential_secret_metadata')) {
        const row = must(rows.get(String(params[0])));
        row.metadata = params[7];
        row.status = params[4];
      }
    });
    const ref = await backend.putSecret({ destinationId: 'dest_1', version: 2, plaintext: 'pw' });

    const material = await backend.getSecret(ref, 2);
    expect(material.plaintext).toBe('pw');
    expect(material.metadata).toMatchObject({
      destinationId: 'dest_1',
      version: 2,
      status: 'active',
    });
    const [sql, params] = must(queryOne.mock.calls[0]);
    expect(sql).toContain('FROM credential_secret_bodies body');
    expect(sql).toContain('WHERE body.credential_ref = ?');
    expect(params).toEqual([ref]);

    must(rows.get(ref)).metadata = null;
    must(rows.get(ref)).status = 'retiring';
    expect((await backend.getSecret(ref)).metadata).toStrictEqual({
      destinationId: 'dest_1',
      version: 2,
      status: 'retiring',
    });
  });

  it('refuses a missing or deleted secret, a ref of another kind and a wrong version', async () => {
    const { backend, rows } = d1();
    const ref = 'd1secret://admin/credential_secrets/dest_1/v1#v1';
    const missing = await failure(backend.getSecret(ref));
    expect(missing.code).toBe('secret_not_found');
    expect(missing.message).toBe('Credential secret was not found.');
    rows.set(ref, {
      destination_id: 'dest_1',
      version: 1,
      envelope_json: '{}',
      metadata: null,
      status: 'deleted',
    });
    expect((await failure(backend.getSecret(ref))).code).toBe('secret_not_found');

    const other = await failure(backend.getSecret('r2secret://admin/x#v1'));
    expect(other.code).toBe('invalid_credential_ref');
    expect(other.message).toBe('Credential ref is not a D1 secret ref.');
    expect((await failure(backend.getSecret(ref, 2))).code).toBe('version_mismatch');
  });

  it('rotates into a next version, unless told otherwise', async () => {
    const { backend, execute } = d1({ now: () => 5000 });
    await backend.rotateSecret({ destinationId: 'dest_1', nextVersion: 2, nextPlaintext: 'new' });
    const first = JSON.parse(String(must(execute.mock.calls[1])[1][7])) as Record<string, unknown>;
    expect(first).toEqual({
      destinationId: 'dest_1',
      version: 2,
      status: 'next',
      contentType: 'text/plain',
      createdAt: 5000,
      rotatedAt: 5000,
    });
    const ref = await backend.rotateSecret({
      destinationId: 'dest_1',
      nextVersion: 3,
      nextPlaintext: 'new',
      metadata: { status: 'active', rotatedAt: 42, labels: { a: 'b' } },
    });
    expect(ref).toBe('d1secret://admin/credential_secrets/dest_1/v3#v3');
    expect(JSON.parse(String(must(execute.mock.calls[3])[1][7]))).toMatchObject({
      status: 'active',
      rotatedAt: 42,
      labels: { a: 'b' },
    });
  });

  it('retires and deletes a secret by its ref', async () => {
    const { backend, execute } = d1({ now: () => 5000 });
    await backend.retireSecret('d1secret://admin/x#v1');
    const [retireSql, retireParams] = must(execute.mock.calls[0]);
    expect(retireSql).toContain("SET status = 'retired', retired_at = ?");
    expect(retireSql).toContain('WHERE credential_ref = ?');
    expect(retireParams).toEqual([5000, 'd1secret://admin/x#v1']);

    await backend.deleteSecret('d1secret://admin/x#v1');
    const [markSql, markParams] = must(execute.mock.calls[1]);
    expect(markSql).toContain("SET status = 'deleted', retired_at = ?");
    expect(markParams).toEqual([5000, 'd1secret://admin/x#v1']);
    const [deleteSql, deleteParams] = must(execute.mock.calls[2]);
    expect(deleteSql).toContain('DELETE FROM credential_secret_bodies');
    expect(deleteParams).toEqual(['d1secret://admin/x#v1']);
  });
});

describe('R2EncryptedCredentialSecretBackend', () => {
  function r2(
    options: {
      withStore?: boolean;
      keyPrefix?: string;
      bucketName?: string;
      keyVersion?: number;
      now?: () => number;
    } = {}
  ) {
    const objects = bucket();
    const sql = sqlStore();
    const { withStore = true, ...rest } = options;
    const backend = new R2EncryptedCredentialSecretBackend({
      bucket: objects.bucket,
      metadataStore: withStore ? sql.store : undefined,
      rootKeyHex,
      ...rest,
    });
    return { backend, objects, sql };
  }

  it('writes the encrypted object and its metadata row', async () => {
    const { backend, objects, sql } = r2({ now: () => 5000 });
    const ref = await backend.putSecret({ destinationId: 'dest_1', version: 2, plaintext: 'pw' });

    expect(backend.kind).toBe('r2_encrypted_object');
    expect(ref).toBe('r2secret://admin-secrets/destinations/dest_1/credentials/v2.json#v2');
    const [key, body, options] = must(objects.put.mock.calls[0]);
    expect(key).toBe('destinations/dest_1/credentials/v2.json');
    expect(JSON.parse(String(body))).toMatchObject({
      algorithm: 'AES-256-GCM',
      backend: 'r2_encrypted_object',
      keyVersion: 1,
      contentType: 'text/plain',
    });
    expect(options).toStrictEqual({
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { credential_ref: ref, destination_id: 'dest_1', version: '2' },
    });
    const [sqlText, params] = must(sql.execute.mock.calls[0]);
    expect(sqlText).toContain('INSERT INTO credential_secret_metadata');
    expect(params.slice(0, 7)).toEqual([
      ref,
      'dest_1',
      'r2_encrypted_object',
      2,
      'active',
      5000,
      null,
    ]);
    expect(JSON.parse(String(params[7]))).toEqual({
      destinationId: 'dest_1',
      version: 2,
      status: 'active',
      contentType: 'text/plain',
      createdAt: 5000,
    });
  });

  it('uses the given bucket name, prefix, key version, status, content type and creation time', async () => {
    const { backend, objects, sql } = r2({
      bucketName: 'my-bucket',
      keyPrefix: '/prefix/',
      keyVersion: 3,
      now: () => 5000,
    });
    const ref = await backend.putSecret({
      destinationId: 'dest_1',
      version: 1,
      plaintext: 'pw',
      metadata: { status: 'next', contentType: 'application/json', createdAt: 12 },
    });
    expect(ref).toBe('r2secret://my-bucket/prefix/dest_1/credentials/v1.json#v1');
    expect(must(objects.put.mock.calls[0])[0]).toBe('prefix/dest_1/credentials/v1.json');
    expect(JSON.parse(String(must(objects.put.mock.calls[0])[1]))).toMatchObject({
      keyVersion: 3,
      contentType: 'application/json',
    });
    expect(must(sql.execute.mock.calls[0])[1].slice(4, 7)).toEqual(['next', 12, null]);
  });

  it('trims slashes from both ends of the key prefix', async () => {
    const prefixOf = async (keyPrefix: string): Promise<string> => {
      const { backend, objects } = r2({ keyPrefix });
      await backend.putSecret({ destinationId: 'd', version: 1, plaintext: 'x' });
      return String(must(objects.put.mock.calls[0])[0]);
    };
    expect(await prefixOf('a')).toBe('a/d/credentials/v1.json');
    expect(await prefixOf('//a//')).toBe('a/d/credentials/v1.json');
    expect(await prefixOf('a/b//')).toBe('a/b/d/credentials/v1.json');
    expect(await prefixOf('//a/b')).toBe('a/b/d/credentials/v1.json');
    expect(await prefixOf('///')).toBe('/d/credentials/v1.json');
    expect(await prefixOf('')).toBe('/d/credentials/v1.json');
  });

  it('cleans the destination id into a safe, bounded key segment', async () => {
    const keyOf = async (destinationId: string): Promise<string> => {
      const { backend, objects } = r2();
      await backend.putSecret({ destinationId, version: 1, plaintext: 'x' });
      return String(must(objects.put.mock.calls[0])[0]);
    };
    expect(await keyOf('a b/c:d')).toBe('destinations/a_b_c_d/credentials/v1.json');
    expect(await keyOf('Az09._=-')).toBe('destinations/Az09._=-/credentials/v1.json');
    expect(await keyOf('x'.repeat(200))).toBe(
      `destinations/${'x'.repeat(128)}/credentials/v1.json`
    );
    expect(await keyOf('')).toBe('destinations/unknown/credentials/v1.json');
  });

  it('refuses a version that is not a positive integer', async () => {
    const { backend, objects } = r2();
    for (const version of [0, -1, 1.5, Number.NaN]) {
      const error = await failure(
        backend.putSecret({ destinationId: 'd', version, plaintext: 'x' })
      );
      expect(error.code).toBe('invalid_credential_ref');
      expect(error.message).toBe('Credential secret version must be a positive integer.');
    }
    expect(objects.put).not.toHaveBeenCalled();
  });

  it('works without a metadata store', async () => {
    const { backend } = r2({ withStore: false });
    const ref = await backend.putSecret({ destinationId: 'dest_1', version: 1, plaintext: 'pw' });
    const material = await backend.getSecret(ref);
    expect(material).toStrictEqual({
      plaintext: 'pw',
      metadata: { destinationId: 'dest_1', version: 1 },
    });
    await expect(backend.retireSecret(ref)).resolves.toBeUndefined();
  });

  it('reads a secret with the metadata of its row', async () => {
    const { backend, sql } = r2({ now: () => 5000 });
    const ref = await backend.putSecret({ destinationId: 'dest_1', version: 2, plaintext: 'pw' });
    sql.rows.set(ref, {
      destination_id: 'dest_1',
      version: '2',
      metadata: JSON.stringify({ destinationId: 'dest_1', version: 2, status: 'active' }),
      status: 'active',
    });
    const material = await backend.getSecret(ref, 2);
    expect(material).toStrictEqual({
      plaintext: 'pw',
      metadata: { destinationId: 'dest_1', version: 2, status: 'active' },
    });
    const [text, params] = must(sql.queryOne.mock.calls[0]);
    expect(text).toContain('FROM credential_secret_metadata');
    expect(text).toContain('WHERE credential_ref = ?');
    expect(params).toEqual([ref]);

    sql.rows.set(ref, { destination_id: 'dest_1', version: 2, metadata: null, status: 'active' });
    expect((await backend.getSecret(ref)).metadata).toStrictEqual({
      destinationId: 'dest_1',
      version: 2,
    });
  });

  it('refuses a missing or deleted secret, and refs of another kind, bucket or version', async () => {
    const { backend, sql, objects } = r2();
    const ref = await backend.putSecret({ destinationId: 'dest_1', version: 1, plaintext: 'pw' });
    const missing = await failure(
      backend.getSecret('r2secret://admin-secrets/destinations/none/credentials/v1.json#v1')
    );
    expect(missing.code).toBe('secret_not_found');
    expect(missing.message).toBe('Credential secret was not found.');

    sql.rows.set(ref, { destination_id: 'dest_1', version: 1, metadata: null, status: 'deleted' });
    const deleted = await failure(backend.getSecret(ref));
    expect(deleted.code).toBe('secret_not_found');
    expect(deleted.message).toBe('Credential secret was not found.');
    sql.rows.clear();

    const kind = await failure(backend.getSecret('d1secret://admin-secrets/x#v1'));
    expect(kind.code).toBe('invalid_credential_ref');
    expect(kind.message).toBe('Credential ref is not an R2 secret ref.');
    const authority = await failure(backend.getSecret('r2secret://other/destinations/x#v1'));
    expect(authority.code).toBe('invalid_credential_ref');
    expect(authority.message).toBe('Credential ref authority does not match this backend.');
    expect((await failure(backend.getSecret(ref, 9))).code).toBe('version_mismatch');
    expect(objects.get).toHaveBeenCalledTimes(2);
  });

  it('looks the object up under the ref path without its leading slashes', async () => {
    const { backend, objects } = r2({ withStore: false });
    await backend.putSecret({ destinationId: 'dest_1', version: 1, plaintext: 'pw' });
    const slashed = 'r2secret://admin-secrets//destinations/dest_1/credentials/v1.json#v1';
    // The ref is bound into the ciphertext, so another spelling of it cannot decrypt the object.
    expect((await failure(backend.getSecret(slashed))).code).toBe('decryption_failed');
    expect(objects.get).toHaveBeenLastCalledWith('destinations/dest_1/credentials/v1.json');
  });

  it('needs the destination and the version from the row or the ref', async () => {
    const { backend, objects } = r2({ withStore: false });
    const ref = await backend.putSecret({ destinationId: 'dest_1', version: 1, plaintext: 'pw' });
    const text = String(objects.objects.get('destinations/dest_1/credentials/v1.json'));
    objects.objects.set('only', text);
    const noVersion = await failure(
      backend.getSecret('r2secret://admin-secrets/destinations/dest_1/credentials/v1.json')
    );
    expect(noVersion.code).toBe('invalid_credential_ref');
    expect(noVersion.message).toBe('Credential ref does not include enough context.');
    const noDestination = await failure(backend.getSecret('r2secret://admin-secrets/only#v1'));
    expect(noDestination.code).toBe('invalid_credential_ref');
    expect(noDestination.message).toBe('Credential ref does not include enough context.');
    expect((await backend.getSecret(ref)).plaintext).toBe('pw');
  });

  it('rotates into a next version, unless told otherwise', async () => {
    const { backend, sql } = r2({ now: () => 5000 });
    const ref = await backend.rotateSecret({
      destinationId: 'dest_1',
      nextVersion: 2,
      nextPlaintext: 'new',
    });
    expect(ref).toBe('r2secret://admin-secrets/destinations/dest_1/credentials/v2.json#v2');
    expect(JSON.parse(String(must(sql.execute.mock.calls[0])[1][7]))).toEqual({
      destinationId: 'dest_1',
      version: 2,
      status: 'next',
      contentType: 'text/plain',
      createdAt: 5000,
      rotatedAt: 5000,
    });
    await backend.rotateSecret({
      destinationId: 'dest_1',
      nextVersion: 3,
      nextPlaintext: 'new',
      metadata: { status: 'active', rotatedAt: 42 },
    });
    expect(JSON.parse(String(must(sql.execute.mock.calls[1])[1][7]))).toMatchObject({
      status: 'active',
      rotatedAt: 42,
    });
  });

  it('retires a secret in the metadata store', async () => {
    const { backend, sql } = r2({ now: () => 5000 });
    await backend.retireSecret('r2secret://admin-secrets/x#v1');
    const [text, params] = must(sql.execute.mock.calls[0]);
    expect(text).toContain("SET status = 'retired', retired_at = ?");
    expect(text).toContain('WHERE credential_ref = ?');
    expect(params).toEqual([5000, 'r2secret://admin-secrets/x#v1']);
  });

  it('deletes the object and marks the metadata row', async () => {
    const { backend, objects, sql } = r2({ now: () => 5000 });
    const ref = await backend.putSecret({ destinationId: 'dest_1', version: 1, plaintext: 'pw' });
    sql.execute.mockClear();
    await backend.deleteSecret(ref);
    expect(objects.del).toHaveBeenCalledWith('destinations/dest_1/credentials/v1.json');
    expect(objects.objects.size).toBe(0);
    const [text, params] = must(sql.execute.mock.calls[0]);
    expect(text).toContain("SET status = 'deleted', retired_at = ?");
    expect(params).toEqual([5000, ref]);

    const bare = r2({ withStore: false });
    const bareRef = await bare.backend.putSecret({
      destinationId: 'd',
      version: 1,
      plaintext: 'x',
    });
    await bare.backend.deleteSecret(bareRef);
    expect(bare.objects.del).toHaveBeenCalledOnce();
    await expect(bare.backend.deleteSecret('d1secret://admin-secrets/x')).rejects.toBeInstanceOf(
      CredentialSecretBackendError
    );
  });

  it('reads the clock when no clock is given', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(7777));
    const { backend, sql } = r2();
    await backend.putSecret({ destinationId: 'd', version: 1, plaintext: 'x' });
    await backend.retireSecret('r2secret://admin-secrets/x#v1');
    expect(must(sql.execute.mock.calls[0])[1][5]).toBe(7777);
    expect(must(sql.execute.mock.calls[1])[1][0]).toBe(7777);
  });
});

describe('ExternalCredentialSecretManagerStub', () => {
  it('is unavailable for every operation', async () => {
    const stub = new ExternalCredentialSecretManagerStub();
    expect(stub.kind).toBe('external_secret_manager');
    const calls: Array<Promise<unknown>> = [
      stub.putSecret({ destinationId: 'd', version: 1, plaintext: 'x' }),
      stub.getSecret('extsecret://a/b#v1'),
      stub.rotateSecret({ destinationId: 'd', nextVersion: 2, nextPlaintext: 'x' }),
      stub.retireSecret('extsecret://a/b#v1'),
      stub.deleteSecret('extsecret://a/b#v1'),
    ];
    for (const call of calls) {
      const error = await failure(call);
      expect(error.code).toBe('backend_unavailable');
      expect(error.message).toBe('External credential secret manager is not configured.');
    }
  });
});

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}
