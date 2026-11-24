import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
} from 'jose';
import { KeyManager } from '../KeyManager.ts';
import {
  base64ToBytes,
  buildCertificate,
  bytesToBase64,
  parseCertificate,
} from '../../vc/x509-certificate';
import type { Env } from '../../types/env';
import type { KeyManagerTenantBackupSnapshot } from '../../services/tenant-portability/key-manager-portability';

vi.mock('../../utils/keys', () => ({
  generateKeySet: async (kid: string) => ({
    publicJWK: {
      kty: 'RSA',
      kid,
      n: `mock-modulus-${kid}`,
      e: 'AQAB',
    },
    privatePEM: [
      '-----BEGIN PRIVATE KEY-----',
      `mock-private-key-${kid}`,
      '-----END PRIVATE KEY-----',
    ].join('\n'),
  }),
}));

/**
 * Mock implementation of DurableObjectState for testing
 */
class MockDurableObjectState {
  public storage = {
    map: new Map<string, unknown>(),

    get: async <T>(key: string): Promise<T | undefined> => {
      return this.storage.map.get(key) as T | undefined;
    },

    put: async <T>(key: string, value: T): Promise<void> => {
      this.storage.map.set(key, value);
    },

    delete: async (key: string): Promise<void> => {
      this.storage.map.delete(key);
    },

    list: async (): Promise<Map<string, unknown>> => {
      return new Map(this.storage.map);
    },

    transaction: async <T>(callback: (transaction: { put: typeof this.put }) => Promise<T>) =>
      callback({ put: this.put.bind(this) }),
  };

  constructor() {
    // Ensure storage methods are bound to the storage object
    this.storage = {
      map: new Map<string, unknown>(),
      get: this.get.bind(this),
      put: this.put.bind(this),
      delete: this.delete.bind(this),
      list: this.list.bind(this),
      transaction: this.transaction.bind(this),
    };
  }

  /**
   * Mock blockConcurrencyWhile - executes callback immediately
   * In production, this blocks all requests until the callback completes
   */
  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return await callback();
  }

  private async get<T>(key: string): Promise<T | undefined> {
    return this.storage.map.get(key) as T | undefined;
  }

  private async put<T>(key: string, value: T): Promise<void> {
    this.storage.map.set(key, value);
  }

  private async delete(key: string): Promise<void> {
    this.storage.map.delete(key);
  }

  private async list(): Promise<Map<string, unknown>> {
    return new Map(this.storage.map);
  }

  private async transaction<T>(
    callback: (transaction: { put: typeof this.put }) => Promise<T>
  ): Promise<T> {
    return callback({ put: this.put.bind(this) });
  }
}

/**
 * Create a mock environment with required bindings
 */
function createMockEnv(secret?: string): Env {
  return {
    KEY_MANAGER_SECRET: secret || 'test-secret-token',
    ISSUER_URL: 'https://test.example.com',
    ACCESS_TOKEN_EXPIRY: '3600',
    AUTH_CODE_EXPIRY: '600',
    STATE_EXPIRY: '600',
    NONCE_EXPIRY: '600',
    // KV namespaces are not needed for KeyManager tests
  } as Env;
}

/**
 * Create an HTTP request for testing
 */
function createRequest(
  path: string,
  method: string = 'GET',
  auth?: string,
  body?: unknown
): Request {
  const headers = new Headers();
  if (auth) {
    headers.set('Authorization', `Bearer ${auth}`);
  }
  if (body) {
    headers.set('Content-Type', 'application/json');
  }

  return new Request(`https://test.example.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function createPortableSnapshot(): Promise<KeyManagerTenantBackupSnapshot> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = {
    kid: 'vc-backup-key',
    algorithm: 'ES256' as const,
    curve: 'P-256' as const,
    publicJWK: {
      ...(await exportJWK(pair.publicKey)),
      kid: 'vc-backup-key',
      use: 'sig',
      alg: 'ES256',
    },
    privatePEM: await exportPKCS8(pair.privateKey),
    createdAt: 100,
    status: 'active' as const,
  };
  const config = { rotationIntervalDays: 90, retentionPeriodDays: 30 };
  return {
    kind: 'authrim.key_manager_tenant_backup.v1',
    version: 1,
    rsa: {
      keys: [],
      activeKeyId: null,
      config,
      lastRotation: null,
      secrets: {
        'saml:pairwise:tenant-a': {
          secretRef: 'saml:pairwise:tenant-a',
          active: { kid: 'secret-a', value: 'secret-value', createdAt: 100 },
          updatedAt: 100,
        },
      },
    },
    vcEc: {
      keys: [key],
      activeKeyIds: { ES256: key.kid, ES384: null, ES512: null },
      config,
      lastRotation: 100,
    },
    oidcEs256: { keys: [], activeKeyId: null, config, lastRotation: null },
    oidcPs256: { keys: [], activeKeyId: null, config, lastRotation: null },
    requestObjectEnc: { keys: [], activeKeyId: null, config, lastRotation: null },
  };
}

describe('KeyManager Durable Object', () => {
  let state: MockDurableObjectState;
  let env: Env;
  let keyManager: KeyManager;

  beforeEach(() => {
    state = new MockDurableObjectState();
    env = createMockEnv();
    keyManager = new KeyManager(state as unknown as DurableObjectState, env);
  });

  describe('mapping hash key lifecycle', () => {
    it('leaves a missing key missing on reads and rotation, then enrolls once', async () => {
      expect(await keyManager.getExistingSecretRpc('field-mapping-hash')).toBeNull();
      await keyManager.listImportedSecretsRpc();
      await keyManager.getStatusRpc();
      expect(await keyManager.getExistingSecretRpc('field-mapping-hash')).toBeNull();
      await expect(keyManager.rotateMappingHashKeyRpc('missing')).rejects.toThrow(
        'mapping_hash_key_missing'
      );
      expect(await keyManager.getExistingSecretRpc('field-mapping-hash')).toBeNull();
      const first = await keyManager.provisionMappingHashKeyRpc();
      const installed = await keyManager.getExistingSecretRpc('field-mapping-hash');
      expect(installed?.active.value).toHaveLength(43);
      expect(await keyManager.provisionMappingHashKeyRpc()).toEqual(first);
      expect(await keyManager.getExistingSecretRpc('field-mapping-hash')).toEqual(installed);
      await expect(keyManager.getOrCreateSecretRpc('field-mapping-hash')).rejects.toThrow(
        'Invalid secret reference'
      );
      await expect(keyManager.rotateSecretRpc('field-mapping-hash')).rejects.toThrow(
        'Invalid secret reference'
      );
      expect(first).toEqual({ kid: installed?.active.kid });
    });

    it('rotates with an idempotent kid precondition and preserves both versions in DR', async () => {
      const snapshot = await createPortableSnapshot();
      snapshot.rsa.secrets['field-mapping-hash'] = {
        secretRef: 'field-mapping-hash',
        active: { kid: 'restored-hash-key', value: 'A'.repeat(43), createdAt: 100 },
        updatedAt: 100,
      };
      await keyManager.importTenantBackupStateRpc(snapshot);
      expect(await keyManager.getExistingSecretRpc('field-mapping-hash')).toEqual(
        snapshot.rsa.secrets['field-mapping-hash']
      );
      const rotated = await keyManager.rotateMappingHashKeyRpc('restored-hash-key');
      expect(rotated.kid).not.toBe('restored-hash-key');
      expect(await keyManager.rotateMappingHashKeyRpc('restored-hash-key')).toEqual(rotated);
      await expect(keyManager.rotateMappingHashKeyRpc('unrelated-tenant-key')).rejects.toThrow(
        'mapping_hash_key_conflict'
      );
      const exported = await keyManager.exportTenantBackupStateRpc();
      expect(exported.rsa.secrets['field-mapping-hash']).toMatchObject({
        active: { kid: rotated.kid },
        previous: snapshot.rsa.secrets['field-mapping-hash'].active,
      });
      expect(await keyManager.verifyTenantBackupStateRpc(exported)).toBe(true);
    });

    it('rolls back failed enrollment without retaining a generated key in memory', async () => {
      await keyManager.getExistingSecretRpc('field-mapping-hash');
      vi.spyOn(state.storage, 'put').mockRejectedValueOnce(new Error('synthetic storage failure'));
      await expect(keyManager.provisionMappingHashKeyRpc()).rejects.toThrow(
        'synthetic storage failure'
      );
      expect(await keyManager.getExistingSecretRpc('field-mapping-hash')).toBeNull();
    });
  });

  it('atomically restores a complete tenant backup state only into an empty KeyManager', async () => {
    const snapshot = await createPortableSnapshot();

    await expect(keyManager.importTenantBackupStateRpc(snapshot)).resolves.toMatchObject({
      imported: true,
      vcKeys: 1,
      secrets: 1,
    });
    await expect(keyManager.verifyTenantBackupStateRpc(snapshot)).resolves.toBe(true);
    await expect(keyManager.exportTenantBackupStateRpc()).resolves.toEqual(snapshot);
    await expect(keyManager.importTenantBackupStateRpc(snapshot)).resolves.toMatchObject({
      imported: false,
    });
    await expect(
      keyManager.importTenantBackupStateRpc({
        ...snapshot,
        rsa: {
          ...snapshot.rsa,
          secrets: {
            ...snapshot.rsa.secrets,
            'directory:tenant-a': {
              secretRef: 'directory:tenant-a',
              active: { kid: 'secret-b', value: 'different', createdAt: 101 },
              updatedAt: 101,
            },
          },
        },
      })
    ).rejects.toThrow('backup_key_manager_target_not_empty');
  });

  it('replaces only the pristine bootstrap key when a restore explicitly permits it', async () => {
    await keyManager.rotateKeysRpc();
    await keyManager.rotateOIDCES256KeyRpc();
    await keyManager.rotateOIDCPS256KeyRpc();
    const snapshot = await createPortableSnapshot();

    await expect(keyManager.importTenantBackupStateRpc(snapshot)).rejects.toThrow(
      'backup_key_manager_target_not_empty'
    );
    await expect(
      keyManager.importTenantBackupStateRpc(snapshot, { replaceBootstrapKey: true })
    ).resolves.toMatchObject({ imported: true });
    await expect(keyManager.verifyTenantBackupStateRpc(snapshot)).resolves.toBe(true);
  });

  it('never replaces a KeyManager that has progressed beyond its bootstrap key', async () => {
    await keyManager.rotateKeysRpc();
    await keyManager.rotateSecretRpc('directory:tenant-a');
    const snapshot = await createPortableSnapshot();

    await expect(
      keyManager.importTenantBackupStateRpc(snapshot, { replaceBootstrapKey: true })
    ).rejects.toThrow('backup_key_manager_target_not_empty');
  });

  it('imports a salt under its own refs only, and never replaces one by mistake', async () => {
    const ref = 'identifier-salt:import:shibboleth';
    const created = await keyManager.importSecretRpc({ secretRef: ref, value: 'c2FsdC0x' });
    expect(created.outcome).toBe('created');
    // The same value again changes nothing.
    await expect(
      keyManager.importSecretRpc({ secretRef: ref, value: 'c2FsdC0x' })
    ).resolves.toMatchObject({ outcome: 'unchanged', fingerprint: created.fingerprint });
    // Another value needs the current one's fingerprint.
    await expect(keyManager.importSecretRpc({ secretRef: ref, value: 'c2FsdC0y' })).rejects.toThrow(
      'imported_secret_replace_mismatch'
    );
    await expect(
      keyManager.importSecretRpc({
        secretRef: ref,
        value: 'c2FsdC0y',
        replaceFingerprint: created.fingerprint,
      })
    ).resolves.toMatchObject({ outcome: 'replaced' });
    // Nothing else can be written through it.
    await expect(
      keyManager.importSecretRpc({ secretRef: 'identifier-salt:default', value: 'x' })
    ).rejects.toThrow('imported_secret_ref_not_allowed');
    const listed = await keyManager.listImportedSecretsRpc();
    expect(listed.map((item) => item.secretRef)).toEqual([ref]);
    expect(JSON.stringify(listed)).not.toContain('c2FsdC0');
    await expect(keyManager.getExistingSecretRpc(ref)).resolves.toMatchObject({
      active: { value: 'c2FsdC0y' },
    });
  });

  describe('imported salt fingerprints', () => {
    const FINGERPRINT_KEY = 'identifier-salt:fingerprint-key';
    const sha256First16 = async (bytes: Uint8Array) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 8), (b) =>
        b.toString(16).padStart(2, '0')
      ).join('');

    it('makes one fingerprint key for imports that begin together', async () => {
      const results = await Promise.all(
        ['one', 'two', 'three'].map((name) =>
          keyManager.importSecretRpc({
            secretRef: `identifier-salt:import:${name}`,
            value: btoa(`salt-${name}`),
          })
        )
      );
      const listed = await keyManager.listImportedSecretsRpc();
      expect(listed).toHaveLength(3);
      for (const [index, name] of ['one', 'two', 'three'].entries()) {
        const entry = listed.find((item) => item.secretRef === `identifier-salt:import:${name}`);
        expect(entry?.fingerprint).toBe(results[index].fingerprint);
      }
    });

    it('is an HMAC under a key of the key manager, not a bare SHA-256 of the salt', async () => {
      const bytes = new TextEncoder().encode('weak-salt');
      const value = btoa('weak-salt');
      const { fingerprint } = await keyManager.importSecretRpc({
        secretRef: 'identifier-salt:import:weak',
        value,
      });
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
      // Neither of the bare hashes an attacker could compute from a guessed salt.
      expect(fingerprint).not.toBe(await sha256First16(bytes));
      expect(fingerprint).not.toBe(await sha256First16(new TextEncoder().encode(value)));
      // Stable: the list and a repeated import give the same.
      const listed = await keyManager.listImportedSecretsRpc();
      expect(listed[0].fingerprint).toBe(fingerprint);
      await expect(
        keyManager.importSecretRpc({ secretRef: 'identifier-salt:import:weak', value })
      ).resolves.toMatchObject({ outcome: 'unchanged', fingerprint });
      // Replacing by the fingerprint keeps working.
      await expect(
        keyManager.importSecretRpc({
          secretRef: 'identifier-salt:import:weak',
          value: btoa('another-salt'),
          replaceFingerprint: fingerprint,
        })
      ).resolves.toMatchObject({ outcome: 'replaced' });
    });

    it('differs between key managers for the same salt', async () => {
      const value = btoa('shared-salt');
      const first = await keyManager.importSecretRpc({
        secretRef: 'identifier-salt:import:s',
        value,
      });
      const other = new KeyManager(
        new MockDurableObjectState() as unknown as DurableObjectState,
        env
      );
      const second = await other.importSecretRpc({ secretRef: 'identifier-salt:import:s', value });
      expect(second.fingerprint).not.toBe(first.fingerprint);
    });

    it('makes the key with the first import only, never when listing', async () => {
      await expect(keyManager.listImportedSecretsRpc()).resolves.toEqual([]);
      await expect(keyManager.getExistingSecretRpc(FINGERPRINT_KEY)).resolves.toBeNull();
      await keyManager.importSecretRpc({
        secretRef: 'identifier-salt:import:a',
        value: btoa('a'),
      });
      const key = await keyManager.getExistingSecretRpc(FINGERPRINT_KEY);
      expect(key?.active.value).toBeTruthy();
      await keyManager.importSecretRpc({
        secretRef: 'identifier-salt:import:b',
        value: btoa('b'),
      });
      // The same key stays.
      await expect(keyManager.getExistingSecretRpc(FINGERPRINT_KEY)).resolves.toEqual(key);
    });
  });

  describe('HMACs of retired identifier values', () => {
    const create = { create: true };

    it('are keyed per key manager, stable, and carry a key id', async () => {
      const first = await keyManager.identifierValueHmacsRpc(['stored\ns\nAAAA', 'x'], create);
      expect(first.hmacs).toHaveLength(2);
      expect(first.hmacs[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(first.keyId).toMatch(/^[0-9a-f]{16}$/);
      // Not a bare hash of the value, and stable.
      const plain = Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stored\ns\nAAAA'))
        ),
        (b) => b.toString(16).padStart(2, '0')
      ).join('');
      expect(first.hmacs[0]).not.toBe(plain);
      await expect(keyManager.identifierValueHmacsRpc(['stored\ns\nAAAA'])).resolves.toEqual({
        keyId: first.keyId,
        hmacs: [first.hmacs[0]],
      });
      const other = new KeyManager(
        new MockDurableObjectState() as unknown as DurableObjectState,
        env
      );
      const second = await other.identifierValueHmacsRpc(['stored\ns\nAAAA'], create);
      expect(second.hmacs[0]).not.toBe(first.hmacs[0]);
      expect(second.keyId).not.toBe(first.keyId);
      // The key is a secret of the key manager (carried by a backup), never made by the private path.
      await expect(
        keyManager.getExistingSecretRpc('identifier-salt:value-hmac-key')
      ).resolves.not.toBeNull();
      await expect(
        keyManager.getOrCreateSecretRpc('identifier-salt:value-hmac-key')
      ).rejects.toThrow('Invalid secret');
      await expect(keyManager.rotateSecretRpc('identifier-salt:value-hmac-key')).rejects.toThrow(
        'Invalid secret'
      );
    });

    it('never makes a key unless asked to: a missing key is refused', async () => {
      await expect(keyManager.identifierValueHmacsRpc(['x'])).rejects.toThrow(
        'identifier_value_key_missing'
      );
      await expect(
        keyManager.getExistingSecretRpc('identifier-salt:value-hmac-key')
      ).resolves.toBeNull();
    });

    it('refuses input that is not a short list of text', async () => {
      await expect(keyManager.identifierValueHmacsRpc([1 as never], create)).rejects.toThrow(
        'identifier_value_hmac_input_invalid'
      );
    });
  });

  describe('refs the private create and rotate paths refuse', () => {
    const refused = ['identifier-salt:import:shibboleth', 'identifier-salt:fingerprint-key'];

    it('refuses them in the RPC methods, so a made-up secret cannot stand in for a salt', async () => {
      for (const ref of refused) {
        await expect(keyManager.getOrCreateSecretRpc(ref)).rejects.toThrow('Invalid secret');
        await expect(keyManager.rotateSecretRpc(ref)).rejects.toThrow('Invalid secret');
      }
      await expect(
        keyManager.getExistingSecretRpc('identifier-salt:import:shibboleth')
      ).resolves.toBeNull();
      // An imported salt is not rotated away by the private path either.
      await keyManager.importSecretRpc({
        secretRef: 'identifier-salt:import:kept',
        value: btoa('kept'),
      });
      await expect(keyManager.rotateSecretRpc('identifier-salt:import:kept')).rejects.toThrow(
        'Invalid secret'
      );
      await expect(
        keyManager.getExistingSecretRpc('identifier-salt:import:kept')
      ).resolves.toMatchObject({
        active: { value: btoa('kept') },
      });
      // The tenant's own salt is still made on first use.
      await expect(
        keyManager.getOrCreateSecretRpc('identifier-salt:default')
      ).resolves.toMatchObject({
        secretRef: 'identifier-salt:default',
      });
    });

    it('refuses them on the internal HTTP routes', async () => {
      const call = (path: string, method: string) =>
        keyManager.fetch(createRequest(path, method, 'test-secret-token'));
      for (const ref of refused) {
        const encoded = encodeURIComponent(ref);
        expect((await call(`/internal/secrets/${encoded}`, 'GET')).status).toBe(400);
        expect((await call(`/internal/secrets/${encoded}/rotate`, 'POST')).status).toBe(400);
      }
      expect((await call('/internal/secrets/identifier-salt%3Adefault', 'GET')).status).toBe(200);
    });
  });

  it('keeps at most 32 imported salts', async () => {
    for (let i = 0; i < 32; i++) {
      await keyManager.importSecretRpc({
        secretRef: `identifier-salt:import:s${i}`,
        value: `v${i}`,
      });
    }
    await expect(
      keyManager.importSecretRpc({ secretRef: 'identifier-salt:import:s32', value: 'v' })
    ).rejects.toThrow('imported_secret_limit');
    // Replacing one that is there is not a new one.
    await expect(
      keyManager.importSecretRpc({ secretRef: 'identifier-salt:import:s0', value: 'v0' })
    ).resolves.toMatchObject({ outcome: 'unchanged' });
  });

  it('keeps an operation snapshot stable until explicit release', async () => {
    const snapshotId = 'ab'.repeat(32);
    await keyManager.startTenantBackupSnapshotRpc(snapshotId);
    const frozen = await keyManager.loadTenantBackupSnapshotRpc(snapshotId);

    await keyManager.rotateSecretRpc('directory:tenant-a');
    expect(await keyManager.exportTenantBackupStateRpc()).not.toEqual(frozen);
    await expect(keyManager.loadTenantBackupSnapshotRpc(snapshotId)).resolves.toEqual(frozen);
    await expect(keyManager.startTenantBackupSnapshotRpc(snapshotId)).resolves.toBeUndefined();

    await expect(keyManager.assertTenantBackupSnapshotReleasedRpc(snapshotId)).rejects.toThrow(
      'backup_key_manager_snapshot_not_released'
    );
    await keyManager.releaseTenantBackupSnapshotRpc(snapshotId);
    await expect(
      keyManager.assertTenantBackupSnapshotReleasedRpc(snapshotId)
    ).resolves.toBeUndefined();
    await expect(keyManager.loadTenantBackupSnapshotRpc(snapshotId)).rejects.toThrow(
      'backup_key_manager_snapshot_missing'
    );
  });

  it('rejects malformed tenant backup snapshot identifiers', async () => {
    await expect(keyManager.startTenantBackupSnapshotRpc('../state')).rejects.toThrow(
      'backup_key_manager_snapshot_id_invalid'
    );
  });

  describe('request object encryption keys', () => {
    it('publishes a dedicated encryption key and decrypts with it only', async () => {
      const keys = await keyManager.getAllOIDCPublicKeysRpc();
      const encryptionKey = keys.find((key) => key.use === 'enc');
      expect(encryptionKey).toMatchObject({ kty: 'RSA', use: 'enc', alg: 'RSA-OAEP-256' });
      expect(encryptionKey?.kid).toMatch(/^request-object-enc-/);
      // Never a signing key.
      const signingKids = keys.filter((key) => key.use === 'sig').map((key) => key.kid);
      expect(signingKids).not.toContain(encryptionKey?.kid);

      // Its private key, by its kid (the round trip is covered with real keys in
      // request-object-encryption.test.ts; keys are mocked here).
      await expect(
        keyManager.getRequestObjectDecryptionKeyRpc(encryptionKey!.kid)
      ).resolves.toMatchObject({ kid: encryptionKey!.kid, status: 'active' });

      // A signing key's kid, or an unknown one, names no decryption key.
      await expect(keyManager.getRequestObjectDecryptionKeyRpc(signingKids[0])).resolves.toBeNull();
      await expect(keyManager.getRequestObjectDecryptionKeyRpc('unknown')).resolves.toBeNull();
    });

    it('stops publishing and decrypting with the previous key once its overlap ends', async () => {
      vi.useFakeTimers({ now: Date.UTC(2026, 9, 4) });
      try {
        const previous = await keyManager.getRequestObjectDecryptionKeyRpc();
        await keyManager.rotateRequestObjectEncKeyRpc();
        vi.setSystemTime(Date.UTC(2026, 9, 5) + 60_000);
        await expect(
          keyManager.getRequestObjectDecryptionKeyRpc(previous!.kid)
        ).resolves.toBeNull();
        const kids = (await keyManager.getAllOIDCPublicKeysRpc()).map((key) => key.kid);
        expect(kids).not.toContain(previous!.kid);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps decrypting with the previous key after a rotation', async () => {
      const previous = await keyManager.getRequestObjectDecryptionKeyRpc();
      const next = await keyManager.rotateRequestObjectEncKeyRpc();
      expect(next.kid).not.toBe(previous!.kid);
      await expect(
        keyManager.getRequestObjectDecryptionKeyRpc(previous!.kid)
      ).resolves.toMatchObject({ kid: previous!.kid, status: 'overlap' });
      await expect(keyManager.getRequestObjectDecryptionKeyRpc()).resolves.toMatchObject({
        kid: next.kid,
      });
    });
  });

  describe('purpose-separated OIDC signing keys', () => {
    it('publishes a dedicated ES256 key without reusing VC EC state', async () => {
      const keys = await keyManager.getAllOIDCPublicKeysRpc();
      const oidcECKey = keys.find((key) => key.alg === 'ES256');
      const oidcPS256Key = keys.find((key) => key.alg === 'PS256');

      expect(oidcECKey).toMatchObject({
        kty: 'EC',
        use: 'sig',
        alg: 'ES256',
        crv: 'P-256',
      });
      expect(oidcECKey?.kid).toMatch(/^oidc-es256-/);
      expect(oidcPS256Key).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'PS256' });
      expect(oidcPS256Key?.kid).toMatch(/^oidc-ps256-/);

      const vcState = state.storage.map.get('ecState') as { keys: unknown[] };
      const oidcState = state.storage.map.get('oidcECState') as { keys: unknown[] };
      const oidcPS256State = state.storage.map.get('oidcPS256State') as { keys: unknown[] };
      expect(vcState.keys).toHaveLength(0);
      expect(oidcState.keys).toHaveLength(1);
      expect(oidcPS256State.keys).toHaveLength(1);
    });
  });

  describe('Authentication', () => {
    it('should require authentication for all endpoints except /jwks', async () => {
      // Note: /jwks is public because it only returns public keys for JWT verification
      const protectedEndpoints = [
        { path: '/active', method: 'GET' },
        { path: '/rotate', method: 'POST' },
        { path: '/should-rotate', method: 'GET' },
        { path: '/config', method: 'GET' },
        { path: '/config', method: 'POST' },
        { path: '/emergency-rotate', method: 'POST' },
        { path: '/status', method: 'GET' },
      ];

      for (const endpoint of protectedEndpoints) {
        const request = createRequest(endpoint.path, endpoint.method);
        const response = await keyManager.fetch(request);

        expect(response.status).toBe(401);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data).toHaveProperty('error', 'Unauthorized');
      }
    });

    it('should allow public access to /jwks endpoint', async () => {
      // First, rotate to create a key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // /jwks should be accessible without authentication
      const request = createRequest('/jwks', 'GET'); // No auth token
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty('keys');
    });

    it('should reject requests with invalid Bearer token', async () => {
      const request = createRequest('/active', 'GET', 'invalid-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(401);
    });

    it('should accept requests with valid Bearer token', async () => {
      const request = createRequest('/active', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      // Should not be 401 (may be 404 if no active key exists)
      expect(response.status).not.toBe(401);
    });

    it('should reject requests without Authorization header', async () => {
      const request = createRequest('/active', 'GET');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(401);
    });

    it('should reject requests when KEY_MANAGER_SECRET is not configured', async () => {
      const envNoSecret = createMockEnv(undefined);
      envNoSecret.KEY_MANAGER_SECRET = undefined;
      const kmNoSecret = new KeyManager(state as unknown as DurableObjectState, envNoSecret);

      const request = createRequest('/active', 'GET', 'any-token');
      const response = await kmNoSecret.fetch(request);

      expect(response.status).toBe(401);
    });
  });

  describe('Private Key Protection', () => {
    it('should not expose private keys in /active endpoint', async () => {
      // First, rotate to create a key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Get active key
      const activeRequest = createRequest('/active', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(activeRequest);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      // Should not contain privatePEM
      expect(data).not.toHaveProperty('privatePEM');
      // Should contain safe fields
      expect(data).toHaveProperty('kid');
      expect(data).toHaveProperty('publicJWK');
      expect(data).toHaveProperty('createdAt');
      expect(data).toHaveProperty('status');
    });

    it('should not expose private keys in /rotate endpoint', async () => {
      const request = createRequest('/rotate', 'POST', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.success).toBe(true);
      expect(data.key).not.toHaveProperty('privatePEM');
      expect(data.key).toHaveProperty('kid');
      expect(data.key).toHaveProperty('publicJWK');
    });

    it('should expose private keys in /internal/active-with-private endpoint', async () => {
      // First, rotate to create a key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Get active key with private
      const request = createRequest('/internal/active-with-private', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      // Should contain privatePEM for internal use
      expect(data).toHaveProperty('privatePEM');
      expect(data).toHaveProperty('kid');
      expect(data).toHaveProperty('publicJWK');
    });

    it('should persist a public certificate for a key only once', async () => {
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      const rotateResponse = await keyManager.fetch(rotateRequest);
      const rotateData = (await rotateResponse.json()) as { key: { kid: string } };

      const firstCertificate = [
        '-----BEGIN CERTIFICATE-----',
        'MIIBtest',
        '-----END CERTIFICATE-----',
      ].join('\n');
      const secondCertificate = [
        '-----BEGIN CERTIFICATE-----',
        'MIIBdifferent',
        '-----END CERTIFICATE-----',
      ].join('\n');

      const firstResponse = await keyManager.fetch(
        createRequest('/internal/certificate', 'POST', 'test-secret-token', {
          kid: rotateData.key.kid,
          certificatePEM: firstCertificate,
          certificateCreatedAt: 1778745600000,
          certificateSha256Thumbprint: 'thumbprint-1',
        })
      );
      expect(firstResponse.status).toBe(200);
      const firstData = (await firstResponse.json()) as Record<string, unknown>;
      expect(firstData.certificatePEM).toBe(firstCertificate);
      expect(firstData.certificateCreatedAt).toBe(1778745600000);
      expect(firstData.certificateSha256Thumbprint).toBe('thumbprint-1');

      const secondResponse = await keyManager.fetch(
        createRequest('/internal/certificate', 'POST', 'test-secret-token', {
          kid: rotateData.key.kid,
          certificatePEM: secondCertificate,
          certificateCreatedAt: 1778745700000,
          certificateSha256Thumbprint: 'thumbprint-2',
        })
      );
      expect(secondResponse.status).toBe(200);
      const secondData = (await secondResponse.json()) as Record<string, unknown>;
      expect(secondData.certificatePEM).toBe(firstCertificate);
      expect(secondData.certificateCreatedAt).toBe(1778745600000);
      expect(secondData.certificateSha256Thumbprint).toBe('thumbprint-1');

      const activeResponse = await keyManager.fetch(
        createRequest('/internal/active-with-private', 'GET', 'test-secret-token')
      );
      const activeData = (await activeResponse.json()) as Record<string, unknown>;
      expect(activeData.certificatePEM).toBe(firstCertificate);
    });

    it('should restore an imported key through the internal import endpoint', async () => {
      const { publicKey, privateKey } = await generateKeyPair('RS256', {
        modulusLength: 2048,
        extractable: true,
      });
      const publicJWK = {
        ...(await exportJWK(publicKey)),
        kty: 'RSA',
        kid: 'restored-saml-key',
        use: 'sig',
        alg: 'RS256',
      };
      const privatePEM = await exportPKCS8(privateKey);
      const response = await keyManager.fetch(
        createRequest('/internal/import-key', 'POST', 'test-secret-token', {
          kid: 'restored-saml-key',
          publicJWK,
          privatePEM,
          certificatePEM: [
            '-----BEGIN CERTIFICATE-----',
            'restored-certificate',
            '-----END CERTIFICATE-----',
          ].join('\n'),
        })
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as { key: Record<string, unknown> };
      expect(data.key.kid).toBe('restored-saml-key');
      expect(data.key).not.toHaveProperty('privatePEM');

      const activeResponse = await keyManager.fetch(
        createRequest('/internal/active-with-private', 'GET', 'test-secret-token')
      );
      const activeData = (await activeResponse.json()) as {
        kid: string;
        privatePEM: string;
        certificatePEM: string;
      };
      expect(activeData.kid).toBe('restored-saml-key');
      expect(activeData.privatePEM).toBe(privatePEM);
      expect(activeData.certificatePEM).toContain('restored-certificate');
    });

    it('should reject imported keys when the public JWK does not match the private key', async () => {
      const { privateKey } = await generateKeyPair('RS256', {
        modulusLength: 2048,
        extractable: true,
      });
      const response = await keyManager.fetch(
        createRequest('/internal/import-key', 'POST', 'test-secret-token', {
          kid: 'restored-saml-key',
          publicJWK: {
            kty: 'RSA',
            kid: 'restored-saml-key',
            n: 'mismatched-modulus',
            e: 'AQAB',
          },
          privatePEM: await exportPKCS8(privateKey),
        })
      );

      expect(response.status).toBe(500);
      const activeResponse = await keyManager.fetch(
        createRequest('/internal/active-with-private', 'GET', 'test-secret-token')
      );
      expect(activeResponse.status).toBe(404);
    });
  });

  describe('Key Generation', () => {
    it('should generate a new key with crypto.randomUUID()', async () => {
      const key1 = await keyManager.generateNewKey();
      const key2 = await keyManager.generateNewKey();

      // Key IDs should be unique
      expect(key1.kid).not.toBe(key2.kid);

      // Key ID format should match pattern: key-{timestamp}-{uuid}
      expect(key1.kid).toMatch(/^key-\d+-[0-9a-f-]+$/);
      expect(key2.kid).toMatch(/^key-\d+-[0-9a-f-]+$/);
    });

    it('should generate keys with correct properties including status', async () => {
      const key = await keyManager.generateNewKey();

      expect(key).toHaveProperty('kid');
      expect(key).toHaveProperty('publicJWK');
      expect(key).toHaveProperty('privatePEM');
      expect(key).toHaveProperty('createdAt');
      expect(key).toHaveProperty('status');

      expect(typeof key.kid).toBe('string');
      expect(typeof key.publicJWK).toBe('object');
      expect(typeof key.privatePEM).toBe('string');
      expect(typeof key.createdAt).toBe('number');
      // New keys start as overlap until set as active
      expect(key.status).toBe('overlap');
    });
  });

  describe('Key Status Management', () => {
    it('should set key status to active after rotation', async () => {
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      const response = await keyManager.fetch(rotateRequest);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.key.status).toBe('active');
    });

    it('should set previous active key to overlap status after rotation', async () => {
      // First rotation
      const rotate1 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response1 = await keyManager.fetch(rotate1);
      const data1 = (await response1.json()) as Record<string, unknown>;
      const firstKid = data1.key.kid;

      // Second rotation
      const rotate2 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response2 = await keyManager.fetch(rotate2);
      const data2 = (await response2.json()) as Record<string, unknown>;

      expect(data2.key.status).toBe('active');
      expect(data2.key.kid).not.toBe(firstKid);

      // Check status endpoint to verify first key is now overlap
      const statusRequest = createRequest('/status', 'GET', 'test-secret-token');
      const statusResponse = await keyManager.fetch(statusRequest);
      const statusData = (await statusResponse.json()) as Record<string, unknown>;

      const firstKey = statusData.keys.find((k: { kid: string }) => k.kid === firstKid);
      expect(firstKey.status).toBe('overlap');
      expect(firstKey).toHaveProperty('expiresAt');
    });

    it('should exclude revoked keys from JWKS', async () => {
      const seededState = new MockDurableObjectState();
      const now = Date.now();
      await seededState.storage.put('state', {
        keys: [
          {
            kid: 'revoked-kid',
            publicJWK: { kty: 'RSA', kid: 'revoked-kid', n: 'revoked-modulus', e: 'AQAB' },
            privatePEM: 'revoked-private-key',
            createdAt: now - 1000,
            status: 'revoked',
            revokedAt: now,
            revokedReason: 'Test key compromise scenario',
          },
          {
            kid: 'active-kid',
            publicJWK: { kty: 'RSA', kid: 'active-kid', n: 'active-modulus', e: 'AQAB' },
            privatePEM: 'active-private-key',
            createdAt: now,
            status: 'active',
          },
        ],
        activeKeyId: 'active-kid',
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: now,
        secrets: {},
      });
      const seededKeyManager = new KeyManager(seededState as unknown as DurableObjectState, env);
      await Promise.resolve();

      // Get JWKS
      const jwksRequest = createRequest('/jwks', 'GET');
      const jwksResponse = await seededKeyManager.fetch(jwksRequest);
      const jwksData = (await jwksResponse.json()) as Record<string, unknown>;

      // Should only have the new active key, not the revoked one
      expect(jwksData.keys.length).toBe(1);

      // Get status to verify revoked key exists but not in JWKS
      const statusRequest = createRequest('/status', 'GET', 'test-secret-token');
      const statusResponse = await seededKeyManager.fetch(statusRequest);
      const statusData = (await statusResponse.json()) as Record<string, unknown>;

      // Should have 2 keys in status (one revoked, one active)
      expect(statusData.keys.length).toBe(2);
      const revokedKey = statusData.keys.find((k: { status: string }) => k.status === 'revoked');
      expect(revokedKey).toBeDefined();
    });
  });

  describe('Secret management', () => {
    it('should create and return a stable internal secret', async () => {
      const firstResponse = await keyManager.fetch(
        createRequest(
          '/internal/secrets/tenant%3Atest%3Asaml%3Apairwise-nameid',
          'GET',
          'test-secret-token'
        )
      );
      const secondResponse = await keyManager.fetch(
        createRequest(
          '/internal/secrets/tenant%3Atest%3Asaml%3Apairwise-nameid',
          'GET',
          'test-secret-token'
        )
      );

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);

      const first = (await firstResponse.json()) as {
        secretRef: string;
        active: { kid: string; value: string };
        previous?: { value: string };
      };
      const second = (await secondResponse.json()) as {
        secretRef: string;
        active: { kid: string; value: string };
      };

      expect(first.secretRef).toBe('tenant:test:saml:pairwise-nameid');
      expect(first.active.value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(second.active.value).toBe(first.active.value);
      expect(first.previous).toBeUndefined();
    });

    it('should rotate an internal secret while retaining the previous value', async () => {
      const initialResponse = await keyManager.fetch(
        createRequest(
          '/internal/secrets/tenant%3Atest%3Asaml%3Apairwise-nameid',
          'GET',
          'test-secret-token'
        )
      );
      const initial = (await initialResponse.json()) as { active: { value: string } };

      const rotateResponse = await keyManager.fetch(
        createRequest(
          '/internal/secrets/tenant%3Atest%3Asaml%3Apairwise-nameid/rotate',
          'POST',
          'test-secret-token'
        )
      );

      expect(rotateResponse.status).toBe(200);
      const rotated = (await rotateResponse.json()) as {
        active: { value: string };
        previous?: { value: string };
      };

      expect(rotated.active.value).not.toBe(initial.active.value);
      expect(rotated.previous?.value).toBe(initial.active.value);
    });

    it.each(['__proto__', 'constructor', 'prototype'])(
      'should reject unsafe secret reference %s',
      async (secretRef) => {
        await expect(keyManager.getOrCreateSecretRpc(secretRef)).rejects.toThrow(
          'Invalid secret reference'
        );

        const response = await keyManager.fetch(
          createRequest(
            `/internal/secrets/${encodeURIComponent(secretRef)}`,
            'GET',
            'test-secret-token'
          )
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: 'Bad Request',
          message: 'Invalid secret reference',
        });
      }
    );

    it('should reject malformed secret references', async () => {
      await expect(keyManager.getOrCreateSecretRpc('tenant ref with spaces')).rejects.toThrow(
        'Invalid secret reference'
      );
      await expect(keyManager.getOrCreateSecretRpc(`tenant:${'a'.repeat(256)}`)).rejects.toThrow(
        'Invalid secret reference'
      );
    });
  });

  describe('Key Rotation', () => {
    it('should rotate keys successfully', async () => {
      const request = createRequest('/rotate', 'POST', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.success).toBe(true);
      expect(data.key).toBeDefined();
      expect(data.key.kid).toBeDefined();
    });

    it('should set new key as active after rotation', async () => {
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      const rotateResponse = await keyManager.fetch(rotateRequest);
      const rotateData = (await rotateResponse.json()) as Record<string, unknown>;
      const newKid = rotateData.key.kid;

      const activeRequest = createRequest('/active', 'GET', 'test-secret-token');
      const activeResponse = await keyManager.fetch(activeRequest);
      const activeData = (await activeResponse.json()) as Record<string, unknown>;

      expect(activeData.kid).toBe(newKid);
      expect(activeData.status).toBe('active');
    });

    it('should handle multiple rotations', async () => {
      const rotateRequest1 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response1 = await keyManager.fetch(rotateRequest1);
      const data1 = (await response1.json()) as Record<string, unknown>;

      const rotateRequest2 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response2 = await keyManager.fetch(rotateRequest2);
      const data2 = (await response2.json()) as Record<string, unknown>;

      // Keys should be different
      expect(data1.key.kid).not.toBe(data2.key.kid);

      // Latest key should be active
      const activeRequest = createRequest('/active', 'GET', 'test-secret-token');
      const activeResponse = await keyManager.fetch(activeRequest);
      const activeData = (await activeResponse.json()) as Record<string, unknown>;

      expect(activeData.kid).toBe(data2.key.kid);
    });
  });

  describe('Emergency Key Rotation', () => {
    it('should perform emergency rotation successfully', async () => {
      // First create an active key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Emergency rotate
      const request = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'Private key compromised - detected in public repository',
      });
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data).toHaveProperty('oldKid');
      expect(data).toHaveProperty('newKid');
      expect(data.oldKid).not.toBe(data.newKid);
    });

    it('should immediately revoke old key on emergency rotation', async () => {
      // Create active key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      const rotateResponse = await keyManager.fetch(rotateRequest);
      const rotateData = (await rotateResponse.json()) as Record<string, unknown>;
      const oldKid = rotateData.key.kid;

      // Emergency rotate
      const emergencyRequest = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'Key compromise detected in logs',
      });
      await keyManager.fetch(emergencyRequest);

      // Check status
      const statusRequest = createRequest('/status', 'GET', 'test-secret-token');
      const statusResponse = await keyManager.fetch(statusRequest);
      const statusData = (await statusResponse.json()) as Record<string, unknown>;

      const oldKey = statusData.keys.find((k: { kid: string }) => k.kid === oldKid);
      expect(oldKey.status).toBe('revoked');
      expect(oldKey).toHaveProperty('revokedAt');
      expect(oldKey.revokedReason).toBe('Key compromise detected in logs');
    });

    it('should require reason for emergency rotation', async () => {
      // Create active key first
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Try emergency rotate without reason
      const request = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {});
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe('Bad Request');
    });

    it('should require minimum 10 characters for reason', async () => {
      // Create active key first
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Try with short reason
      const request = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'short',
      });
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(400);
    });

    it('should fail if no active key exists', async () => {
      // Try emergency rotate without any keys
      const request = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'Testing without active key',
      });
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(500);
    });
  });

  describe('Status Endpoint', () => {
    it('should return status of all keys', async () => {
      // Create some keys
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/status', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data).toHaveProperty('keys');
      expect(data).toHaveProperty('activeKeyId');
      expect(data).toHaveProperty('lastRotation');
      expect(Array.isArray(data.keys)).toBe(true);
      expect(data.keys.length).toBe(2);
    });

    it('should not expose private keys in status endpoint', async () => {
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/status', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);
      const data = (await response.json()) as Record<string, unknown>;

      for (const key of data.keys) {
        expect(key).not.toHaveProperty('privatePEM');
        expect(key).not.toHaveProperty('publicJWK');
        expect(key).toHaveProperty('kid');
        expect(key).toHaveProperty('status');
        expect(key).toHaveProperty('createdAt');
      }
    });
  });

  describe('JWKS Endpoint', () => {
    it('should return all public keys except revoked', async () => {
      // Rotate to create some keys
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/jwks', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data).toHaveProperty('keys');
      expect(Array.isArray(data.keys)).toBe(true);
      // Should have 2 keys (1 active, 1 overlap)
      expect(data.keys.length).toBe(2);
    });
  });

  describe('Configuration', () => {
    it('should return default configuration', async () => {
      const request = createRequest('/config', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const config = (await response.json()) as Record<string, unknown>;

      expect(config).toHaveProperty('rotationIntervalDays');
      expect(config).toHaveProperty('retentionPeriodDays');
      expect(config.rotationIntervalDays).toBe(90);
      expect(config.retentionPeriodDays).toBe(30);
    });

    it('should update configuration', async () => {
      const newConfig = {
        rotationIntervalDays: 60,
        retentionPeriodDays: 15,
      };

      const updateRequest = createRequest('/config', 'POST', 'test-secret-token', newConfig);
      const updateResponse = await keyManager.fetch(updateRequest);

      expect(updateResponse.status).toBe(200);
      const updateData = (await updateResponse.json()) as Record<string, unknown>;
      expect(updateData.success).toBe(true);

      // Verify configuration was updated
      const getRequest = createRequest('/config', 'GET', 'test-secret-token');
      const getResponse = await keyManager.fetch(getRequest);
      const config = (await getResponse.json()) as Record<string, unknown>;

      expect(config.rotationIntervalDays).toBe(60);
      expect(config.retentionPeriodDays).toBe(15);
    });
  });

  describe('Rotation Check', () => {
    it('should indicate rotation needed when no keys exist', async () => {
      const request = createRequest('/should-rotate', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.shouldRotate).toBe(true);
    });

    it('should indicate rotation not needed after recent rotation', async () => {
      // Rotate to create a key
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/should-rotate', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      // Should not need rotation immediately after rotating
      expect(data.shouldRotate).toBe(false);
    });
  });

  describe('Migration (isActive to status)', () => {
    it('should migrate old isActive schema to new status schema', async () => {
      // Simulate old schema data
      const oldSchemaState = {
        keys: [
          {
            kid: 'old-key-1',
            publicJWK: { kty: 'RSA', n: 'test', e: 'AQAB' },
            privatePEM: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
            createdAt: Date.now() - 1000000,
            isActive: false,
          },
          {
            kid: 'old-key-2',
            publicJWK: { kty: 'RSA', n: 'test2', e: 'AQAB' },
            privatePEM: '-----BEGIN PRIVATE KEY-----\ntest2\n-----END PRIVATE KEY-----',
            createdAt: Date.now(),
            isActive: true,
          },
        ],
        activeKeyId: 'old-key-2',
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: Date.now(),
      };

      // Set old schema data directly
      await state.storage.put('state', oldSchemaState);

      // Create new KeyManager instance to trigger migration
      const newKeyManager = new KeyManager(state as unknown as DurableObjectState, env);

      // Access status endpoint to trigger initialization and migration
      const request = createRequest('/status', 'GET', 'test-secret-token');
      const response = await newKeyManager.fetch(request);
      const data = (await response.json()) as Record<string, unknown>;

      // Check migration worked
      const key1 = data.keys.find((k: { kid: string }) => k.kid === 'old-key-1');
      const key2 = data.keys.find((k: { kid: string }) => k.kid === 'old-key-2');

      expect(key1.status).toBe('overlap'); // was isActive: false
      expect(key2.status).toBe('active'); // was isActive: true
      expect(key1).not.toHaveProperty('isActive');
      expect(key2).not.toHaveProperty('isActive');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 when no active key exists', async () => {
      const request = createRequest('/active', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(404);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toContain('No active key found');
    });

    it('should return 404 for unknown endpoints', async () => {
      const request = createRequest('/unknown', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(404);
    });
  });

  describe('VCI access-token signing RPC', () => {
    it('signs only the bounded token contract without exporting credential claims', async () => {
      const activeKey = await keyManager.rotateECKeysRpc('ES256');
      const result = await keyManager.signVCIAccessTokenRpc({
        tenantId: 'tenant-a',
        userId: 'user-a',
        offerId: 'g1:apac:1:co_offer-a',
        credentialConfigurationId: 'UniversityDegreeCredential',
        issuer: 'https://issuer.example.com/vci',
        audience: 'https://issuer.example.com',
        expiresInSeconds: 3600,
      });
      const publicKey = await importJWK(activeKey.publicJWK, 'ES256');
      const verified = await jwtVerify(result.token, publicKey, {
        issuer: 'https://issuer.example.com/vci',
        audience: 'https://issuer.example.com',
      });
      // Bearer issuance tokens are capped at five minutes whatever the caller asks for
      expect((verified.payload.exp ?? 0) - (verified.payload.iat ?? 0)).toBe(300);

      expect(verified.payload).toMatchObject({
        sub: 'user-a',
        tenant_id: 'tenant-a',
        offer_id: 'g1:apac:1:co_offer-a',
        credential_configuration_id: 'UniversityDegreeCredential',
        scope: 'credential',
      });
      expect(decodeJwt(result.token)).not.toHaveProperty('credential_claims');
      expect(result.jti).toBe(verified.payload.jti);
    });

    it('rejects unbounded signing input before using a key', async () => {
      await expect(
        keyManager.signVCIAccessTokenRpc({
          tenantId: ' ',
          userId: 'user-a',
          offerId: 'offer-a',
          credentialConfigurationId: 'UniversityDegreeCredential',
          issuer: 'https://issuer.example.com/vci',
          audience: 'https://issuer.example.com',
        })
      ).rejects.toThrow('invalid_vci_access_token_signing_input');
    });

    it('requires an explicit audience', async () => {
      await expect(
        keyManager.signVCIAccessTokenRpc({
          tenantId: 'tenant-a',
          userId: 'user-a',
          offerId: 'offer-a',
          credentialConfigurationId: 'UniversityDegreeCredential',
          issuer: 'https://issuer.example.com/vci',
          audience: ' ',
        })
      ).rejects.toThrow('invalid_vci_access_token_signing_input');
    });
  });

  describe('SD-JWT issuer signing RPC', () => {
    it('signs a bounded VC payload with a fixed protected header', async () => {
      const activeKey = await keyManager.rotateECKeysRpc('ES256');
      const now = Math.floor(Date.now() / 1000);
      const result = await keyManager.signSDJWTIssuerRpc({
        iss: 'did:web:issuer.example.com',
        vct: 'https://issuer.example.com/credentials/identity/v1',
        iat: now,
        _sd_alg: 'sha-256',
        _sd: ['digest-a'],
      });
      const publicKey = await importJWK(activeKey.publicJWK, 'ES256');

      await expect(jwtVerify(result.token, publicKey)).resolves.toMatchObject({
        payload: { iss: 'did:web:issuer.example.com', iat: now, _sd_alg: 'sha-256' },
      });
      expect(decodeProtectedHeader(result.token)).toEqual({
        alg: 'ES256',
        typ: 'dc+sd-jwt',
        kid: activeKey.kid,
      });
    });

    it('creates the VC issuer key on first use and shares it across concurrent signers', async () => {
      expect((await keyManager.getVcIssuerJwksRpc()).keys).toEqual([]);
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: 'https://issuer.example.com',
        vct: 'https://issuer.example.com/credentials/admin/v1',
        iat: now,
        _sd_alg: 'sha-256',
      };
      const [first, second] = await Promise.all([
        keyManager.signSDJWTIssuerRpc(payload),
        keyManager.signSDJWTIssuerRpc(payload),
      ]);

      expect(first.kid).toBe(second.kid);
      const { keys } = await keyManager.getVcIssuerJwksRpc();
      expect(keys.map((key) => key.kid)).toEqual([first.kid]);
      const publicKey = await importJWK(keys[0], 'ES256');
      await expect(jwtVerify(first.token, publicKey)).resolves.toBeDefined();
    });

    it('rejects oversized and structurally invalid VC payloads', async () => {
      await expect(
        keyManager.signSDJWTIssuerRpc({
          iss: 'did:web:issuer.example.com',
          vct: 'IdentityCredential',
          iat: Math.floor(Date.now() / 1000),
          _sd_alg: 'none',
        })
      ).rejects.toThrow('invalid_sd_jwt_issuer_signing_input');
    });
  });

  describe('Status List signing RPC', () => {
    it('signs only a bounded Bitstring Status List credential contract', async () => {
      const activeKey = await keyManager.rotateECKeysRpc('ES256');
      const now = Math.floor(Date.now() / 1000);
      const result = await keyManager.signStatusListCredentialRpc({
        iss: 'did:web:issuer.example.com',
        sub: 'https://issuer.example.com/vci/status/list-a',
        iat: now,
        exp: now + 3600,
        vc: {
          type: ['VerifiableCredential', 'BitstringStatusListCredential'],
          credentialSubject: {
            type: 'BitstringStatusList',
            statusPurpose: 'revocation',
            encodedList: 'encoded-list',
          },
        },
      });
      const publicKey = await importJWK(activeKey.publicJWK, 'ES256');

      await expect(jwtVerify(result.token, publicKey)).resolves.toMatchObject({
        payload: { sub: 'https://issuer.example.com/vci/status/list-a' },
      });
      expect(decodeProtectedHeader(result.token).typ).toBe('statuslist+jwt');
    });

    it('rejects a non-status credential payload', async () => {
      await expect(
        keyManager.signStatusListCredentialRpc({
          iss: 'did:web:issuer.example.com',
          sub: 'https://issuer.example.com/vci/status/list-a',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          vc: { type: ['VerifiableCredential'] },
        })
      ).rejects.toThrow('invalid_status_list_signing_input');
    });
  });

  describe('Token Status List signing RPC', () => {
    const validPayload = () => {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: 'https://issuer.example.com/t1',
        sub: 'https://issuer.example.com/t1/vci/status-lists/list-a',
        iat: now,
        exp: now + 86400,
        ttl: 300,
        status_list: { bits: 2, lst: 'eJzTBwAAAQAB' },
      };
    };

    it('signs the draft-14 token shape for an https issuer', async () => {
      const activeKey = await keyManager.rotateECKeysRpc('ES256');
      const result = await keyManager.signStatusListCredentialRpc(validPayload());
      const publicKey = await importJWK(activeKey.publicJWK, 'ES256');

      await expect(jwtVerify(result.token, publicKey)).resolves.toMatchObject({
        payload: { ttl: 300, status_list: { bits: 2 } },
      });
      expect(decodeProtectedHeader(result.token)).toMatchObject({
        typ: 'statuslist+jwt',
        kid: activeKey.kid,
      });
    });

    it.each([
      [
        'a sub on another origin',
        (p: ReturnType<typeof validPayload>) => ({ ...p, sub: 'https://evil.example.net/x' }),
      ],
      [
        'a non-https issuer',
        (p: ReturnType<typeof validPayload>) => ({ ...p, iss: 'http://issuer.example.com' }),
      ],
      ['a missing ttl', ({ ttl: _ttl, ...p }: ReturnType<typeof validPayload>) => p],
      ['a zero ttl', (p: ReturnType<typeof validPayload>) => ({ ...p, ttl: 0 })],
      ['a ttl over a day', (p: ReturnType<typeof validPayload>) => ({ ...p, ttl: 86401 })],
      [
        'unsupported bits',
        (p: ReturnType<typeof validPayload>) => ({ ...p, status_list: { bits: 3, lst: 'x' } }),
      ],
      [
        'a non-string list',
        (p: ReturnType<typeof validPayload>) => ({ ...p, status_list: { bits: 2, lst: 7 } }),
      ],
      [
        'an expiry beyond 24 hours',
        (p: ReturnType<typeof validPayload>) => ({ ...p, exp: p.exp + 3600 }),
      ],
      ['an extra claim', (p: ReturnType<typeof validPayload>) => ({ ...p, admin: true })],
      ['an old iat', (p: ReturnType<typeof validPayload>) => ({ ...p, iat: p.iat - 3600 })],
    ])('rejects %s', async (_label, mutate) => {
      await expect(keyManager.signStatusListCredentialRpc(mutate(validPayload()))).rejects.toThrow(
        'invalid_status_list_signing_input'
      );
    });
  });

  describe('VC issuer key certificate chain (x5c)', () => {
    const HOST = 'issuer.example.com';
    const HOUR = 60 * 60 * 1000;

    interface CaKey {
      privateKey: CryptoKey;
      publicJwk: JWK;
    }

    async function newCaKey(): Promise<CaKey> {
      const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
      const jwk = await exportJWK(publicKey);
      return { privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
    }

    const signWith = (key: CaKey) => async (tbs: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, tbs)
      );

    async function fingerprint(base64Der: string): Promise<string> {
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', base64ToBytes(base64Der))
      );
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Issuing CA plus a leaf for `publicKey`. Returns the `x5c` chain (root excluded) and the
     * root certificate. Unless `trust` is false the environment is told to trust this CA.
     */
    async function issueChain(
      publicKey: JWK,
      options: {
        host?: string;
        extraHost?: string;
        leafLifetimeMs?: number;
        caLifetimeMs?: number;
        trust?: boolean;
        withRoot?: boolean;
        caPathLength?: number;
        leafCommonName?: string;
        eku?: boolean;
      } = {}
    ): Promise<string[]> {
      const now = Date.now();
      const root = await newCaKey();
      const ca = await newCaKey();
      const rootCert = await buildCertificate(
        {
          subject: { commonName: 'Test Root CA', organization: 'Test' },
          issuer: { commonName: 'Test Root CA', organization: 'Test' },
          subjectPublicKey: root.publicJwk,
          issuerPublicKey: root.publicJwk,
          notBefore: new Date(now - 2000 * HOUR),
          notAfter: new Date(now + 5000 * HOUR),
          isCA: true,
          pathLength: 1,
        },
        signWith(root)
      );
      const caCert = await buildCertificate(
        {
          subject: { commonName: 'Test Issuing CA', organization: 'Test' },
          issuer: { commonName: 'Test Root CA', organization: 'Test' },
          subjectPublicKey: ca.publicJwk,
          issuerPublicKey: root.publicJwk,
          notBefore: new Date(now - HOUR),
          notAfter: new Date(now + (options.caLifetimeMs ?? 1000 * HOUR)),
          isCA: true,
          pathLength: options.caPathLength ?? 0,
        },
        signWith(root)
      );
      const host = options.host ?? HOST;
      const leafCert = await buildCertificate(
        {
          subject: { commonName: options.leafCommonName ?? host },
          issuer: { commonName: 'Test Issuing CA', organization: 'Test' },
          subjectPublicKey: publicKey,
          issuerPublicKey: ca.publicJwk,
          notBefore: new Date(now - 5 * 60_000),
          notAfter: new Date(now + (options.leafLifetimeMs ?? 48 * HOUR)),
          dnsNames: [host, ...(options.extraHost ? [options.extraHost] : [])],
          isCA: false,
          extraExtensions: options.eku
            ? [
                {
                  oid: '2.5.29.37',
                  critical: false,
                  value: Uint8Array.from([
                    0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01,
                  ]),
                },
              ]
            : undefined,
        },
        signWith(ca)
      );
      const chain = [bytesToBase64(leafCert), bytesToBase64(caCert)];
      if (options.trust !== false) env.VC_X5C_ISSUING_CA_SHA256 = await fingerprint(chain[1]);
      return options.withRoot ? [...chain, bytesToBase64(rootCert)] : chain;
    }

    const vcPayload = (extra: Record<string, unknown> = {}) => ({
      iss: 'https://issuer.example.com',
      vct: 'https://authrim.com/credentials/admin/v1',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      _sd_alg: 'sha-256',
      _sd: ['digest-a'],
      ...extra,
    });

    const statusPayload = (iss = 'https://issuer.example.com') => {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss,
        sub: `${iss}/vci/status-lists/list-a`,
        iat: now,
        exp: now + 86400,
        ttl: 300,
        status_list: { bits: 2, lst: 'eJzTBwAAAQAB' },
      };
    };

    const register = (kid: string, chain: string[], issuerHost = HOST) =>
      keyManager.setVcIssuerKeyCertificateChainRpc({ kid, chain, issuerHost });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('HAIP login request objects', () => {
      const b64url = (bytes: Uint8Array) =>
        btoa(String.fromCharCode(...bytes))
          .replace(/\+/gu, '-')
          .replace(/\//gu, '_')
          .replace(/=+$/u, '');
      const clientIdOf = async (chain: string[]) =>
        `x509_hash:${b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', base64ToBytes(chain[0]))))}`;
      const loginPayload = async (chain: string[], extra: Record<string, unknown> = {}) => {
        const now = Math.floor(Date.now() / 1000);
        const ephemeral = await newCaKey();
        return {
          aud: 'https://self-issued.me/v2',
          client_id: await clientIdOf(chain),
          response_type: 'vp_token',
          response_mode: 'direct_post.jwt',
          response_uri: `https://${HOST}/vp/login/response`,
          nonce: 'n'.repeat(24),
          state: 's'.repeat(24),
          iat: now,
          exp: now + 300,
          client_metadata: { jwks: { keys: [{ ...ephemeral.publicJwk, kid: 'req-1' }] } },
          dcql_query: {
            credentials: [
              {
                id: 'admin',
                format: 'dc+sd-jwt',
                meta: { vct_values: ['https://example.com/vct/admin'] },
                claims: [{ path: ['sub'] }],
                trusted_authorities: [{ type: 'aki', values: ['AAAA'] }],
              },
            ],
          },
          ...extra,
        };
      };

      it('names the verifier by the leaf of the key chain and its CA, only for a key with a usable chain', async () => {
        const key = await keyManager.rotateECKeysRpc('ES256');
        expect(await keyManager.getHaipLoginVerifierRpc()).toBeNull();
        const chain = await issueChain(key.publicJWK);
        await register(key.kid, chain);
        const verifier = await keyManager.getHaipLoginVerifierRpc();
        expect(verifier).toMatchObject({
          clientId: await clientIdOf(chain),
          issuerHost: HOST,
        });
        expect(verifier?.issuingCaAki).toBe(
          b64url(parseCertificate(base64ToBytes(chain[1])).subjectKeyIdentifier as Uint8Array)
        );
        // A CA that is no longer trusted ends it.
        env.VC_X5C_ISSUING_CA_SHA256 = '0'.repeat(64);
        expect(await keyManager.getHaipLoginVerifierRpc()).toBeNull();
      });

      it('signs the one login request shape with typ and the x5c chain, verifiable with the leaf key', async () => {
        const key = await keyManager.rotateECKeysRpc('ES256');
        const chain = await issueChain(key.publicJWK);
        await register(key.kid, chain);
        const payload = await loginPayload(chain);
        const signed = await keyManager.signHaipLoginRequestRpc(payload);
        expect(signed.kid).toBe(key.kid);
        expect(decodeProtectedHeader(signed.token)).toEqual({
          alg: 'ES256',
          typ: 'oauth-authz-req+jwt',
          x5c: chain,
        });
        await expect(
          jwtVerify(signed.token, await importJWK(key.publicJWK, 'ES256'))
        ).resolves.toBeDefined();
      });

      it('refuses a client id that is not the hash of its own leaf, another response host and no chain', async () => {
        const key = await keyManager.rotateECKeysRpc('ES256');
        // No chain yet.
        const unchained = await issueChain(key.publicJWK, { trust: false });
        await expect(
          keyManager.signHaipLoginRequestRpc(await loginPayload(unchained))
        ).rejects.toThrow('x5c_required');
        const chain = await issueChain(key.publicJWK);
        await register(key.kid, chain);
        const other = await issueChain((await newCaKey()).publicJwk);
        await register(key.kid, chain).catch(() => undefined);
        for (const extra of [
          { client_id: await clientIdOf(other) },
          { client_id: 'x509_hash:AAAA' },
          { response_uri: 'https://evil.example.com/vp/login/response' },
          // The same host, another path, query or an extra claim is not a login request either.
          { response_uri: `https://${HOST}/vp/other` },
          { response_uri: `https://${HOST}/vp/login/response?x=1` },
          { extra_claim: 'x' },
          { dcql_query: { credentials: [] } },
          {
            dcql_query: {
              credentials: [{ id: 'a', format: 'dc+sd-jwt', meta: { vct_values: ['a', 'b'] } }],
            },
          },
        ]) {
          await expect(
            keyManager.signHaipLoginRequestRpc(await loginPayload(chain, extra))
          ).rejects.toThrow(/x5c_required|invalid_haip_login_request_signing_input/u);
        }
      });

      it('refuses payloads that are not the fixed shape', async () => {
        const key = await keyManager.rotateECKeysRpc('ES256');
        const chain = await issueChain(key.publicJWK);
        await register(key.kid, chain);
        const now = Math.floor(Date.now() / 1000);
        for (const extra of [
          { response_mode: 'direct_post' },
          { response_type: 'code' },
          { aud: 'https://other.example.com' },
          { state: 'short' },
          { nonce: 'short' },
          { iat: now - 3600, exp: now - 3000 },
          { exp: now + 3600 },
          { client_metadata: { jwks: { keys: [] } } },
          { client_metadata: { jwks: { keys: [{ kty: 'RSA', kid: 'x' }] } } },
          { response_uri: 'http://' + HOST + '/vp/login/response' },
        ]) {
          await expect(
            keyManager.signHaipLoginRequestRpc(await loginPayload(chain, extra))
          ).rejects.toThrow('invalid_haip_login_request_signing_input');
        }
        // An expiry past the chain's life is refused as well.
        const long = await loginPayload(chain);
        vi.useFakeTimers({ now: Date.now() + 100 * 60 * 60 * 1000 });
        await expect(
          keyManager.signHaipLoginRequestRpc({
            ...long,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
          })
        ).rejects.toThrow();
      });
    });

    it('adds x5c to SD-JWT VCs and status list tokens once a chain is stored', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      const stored = await register(key.kid, chain);
      expect(stored.kid).toBe(key.kid);
      expect(stored.leafNotAfter).toBeGreaterThan(Date.now());
      expect(stored.chainNotAfter).toBeLessThanOrEqual(stored.leafNotAfter);

      const publicKey = await importJWK(key.publicJWK, 'ES256');
      const credential = await keyManager.signSDJWTIssuerRpc(vcPayload());
      await expect(jwtVerify(credential.token, publicKey)).resolves.toBeDefined();
      expect(decodeProtectedHeader(credential.token)).toEqual({
        alg: 'ES256',
        typ: 'dc+sd-jwt',
        kid: key.kid,
        x5c: chain,
      });

      const list = await keyManager.signStatusListCredentialRpc(statusPayload());
      await expect(jwtVerify(list.token, publicKey)).resolves.toBeDefined();
      expect(decodeProtectedHeader(list.token)).toEqual({
        alg: 'ES256',
        typ: 'statuslist+jwt',
        kid: key.kid,
        x5c: chain,
      });
    });

    it('leaves the header unchanged for a key without a chain', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const credential = await keyManager.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(credential.token)).toEqual({
        alg: 'ES256',
        typ: 'dc+sd-jwt',
        kid: key.kid,
      });
    });

    it('keeps the chain across a restart of the Durable Object', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      await register(key.kid, chain);

      const restarted = new KeyManager(state as unknown as DurableObjectState, env);
      const credential = await restarted.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(credential.token).x5c).toEqual(chain);
    });

    it('does not carry the chain over to a rotated key', async () => {
      const first = await keyManager.rotateECKeysRpc('ES256');
      await register(first.kid, await issueChain(first.publicJWK));
      const second = await keyManager.rotateECKeysRpc('ES256');
      const credential = await keyManager.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(credential.token)).toEqual({
        alg: 'ES256',
        typ: 'dc+sd-jwt',
        kid: second.kid,
      });
    });

    it('stops sending x5c once the leaf has expired', async () => {
      vi.useFakeTimers({ now: Date.UTC(2026, 10, 22) });
      const key = await keyManager.rotateECKeysRpc('ES256');
      await register(key.kid, await issueChain(key.publicJWK, { leafLifetimeMs: 2 * HOUR }));
      expect(
        decodeProtectedHeader((await keyManager.signSDJWTIssuerRpc(vcPayload())).token).x5c
      ).toBeDefined();

      vi.setSystemTime(Date.UTC(2026, 10, 22) + 3 * HOUR);
      const late = await keyManager.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(late.token).x5c).toBeUndefined();
    });

    it('stops sending x5c when the issuing CA expires before the leaf', async () => {
      vi.useFakeTimers({ now: Date.UTC(2026, 10, 22) });
      const key = await keyManager.rotateECKeysRpc('ES256');
      const stored = await register(
        key.kid,
        await issueChain(key.publicJWK, { leafLifetimeMs: 100 * HOUR, caLifetimeMs: 2 * HOUR })
      );
      expect(stored.chainNotAfter).toBeLessThan(stored.leafNotAfter);

      vi.setSystemTime(Date.UTC(2026, 10, 22) + 3 * HOUR); // CA expired, leaf still valid
      const late = await keyManager.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(late.token).x5c).toBeUndefined();
      const list = await keyManager.signStatusListCredentialRpc(statusPayload());
      expect(decodeProtectedHeader(list.token).x5c).toBeUndefined();
    });

    it('sends x5c only when the chain outlives the credential', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK, { leafLifetimeMs: 48 * HOUR });
      await register(key.kid, chain);
      const nowSeconds = Math.floor(Date.now() / 1000);

      const within = await keyManager.signSDJWTIssuerRpc(vcPayload({ exp: nowSeconds + 3600 }));
      expect(decodeProtectedHeader(within.token).x5c).toEqual(chain);
      const beyond = await keyManager.signSDJWTIssuerRpc(
        vcPayload({ exp: nowSeconds + 30 * 86400 })
      );
      expect(decodeProtectedHeader(beyond.token).x5c).toBeUndefined();
    });

    it('sends x5c only for the issuer host the chain was validated for', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      await register(key.kid, chain);

      for (const iss of ['https://other.example.com', 'http://issuer.example.com', 'not a url']) {
        const token = (await keyManager.signSDJWTIssuerRpc(vcPayload({ iss }))).token;
        expect(decodeProtectedHeader(token).x5c).toBeUndefined();
      }
      const list = await keyManager.signStatusListCredentialRpc(
        statusPayload('https://other.example.com')
      );
      expect(decodeProtectedHeader(list.token).x5c).toBeUndefined();

      const tenantPath = await keyManager.signSDJWTIssuerRpc(
        vcPayload({ iss: 'https://ISSUER.example.com/t1' })
      );
      expect(decodeProtectedHeader(tenantPath.token).x5c).toEqual(chain);
      const didWeb = await keyManager.signSDJWTIssuerRpc(
        vcPayload({ iss: 'did:web:issuer.example.com' })
      );
      expect(decodeProtectedHeader(didWeb.token).x5c).toEqual(chain);
    });

    it('refuses a chain whose leaf certifies another key', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const other = await newCaKey();
      await expect(register(key.kid, await issueChain(other.publicJwk))).rejects.toThrow(
        'leaf_key_mismatch'
      );
    });

    it('refuses another host, a second name, a wrong-name issuer and malformed chains', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      await expect(
        register(key.kid, await issueChain(key.publicJWK, { host: 'other.example.com' }))
      ).rejects.toThrow('leaf_host_mismatch');
      await expect(
        register(key.kid, await issueChain(key.publicJWK, { extraHost: 'www.example.com' }))
      ).rejects.toThrow('leaf_host_mismatch');
      await expect(register(key.kid, ['not base64!', 'AAAA'])).rejects.toThrow();
      await expect(register(key.kid, [])).rejects.toThrow('invalid_certificate_chain');
      // Nothing was stored by the failed attempts.
      const credential = await keyManager.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(credential.token).x5c).toBeUndefined();
    });

    it('accepts exactly leaf plus issuing CA: a chain that includes the root is refused', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      await expect(
        register(key.kid, await issueChain(key.publicJWK, { withRoot: true }))
      ).rejects.toThrow('invalid_certificate_chain');
    });

    it('refuses a chain that does not end in the configured issuing CA', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      // The environment trusts another CA than the one that issued this chain.
      env.VC_X5C_ISSUING_CA_SHA256 = 'a'.repeat(64);
      await expect(register(key.kid, chain)).rejects.toThrow('untrusted_issuing_ca');
      // A structurally valid chain from a different PKI is equally refused.
      const other = await issueChain(key.publicJWK, { trust: false });
      await expect(register(key.kid, other)).rejects.toThrow('untrusted_issuing_ca');
    });

    it('refuses every chain until an issuing CA is configured', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK, { trust: false });
      delete env.VC_X5C_ISSUING_CA_SHA256;
      await expect(register(key.kid, chain)).rejects.toThrow('vc_x5c_trust_anchor_not_configured');
      env.VC_X5C_ISSUING_CA_SHA256 = 'not-a-fingerprint, ';
      await expect(register(key.kid, chain)).rejects.toThrow('vc_x5c_trust_anchor_not_configured');
    });

    it('refuses an unknown key id, a bad key id and a revoked key', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      await expect(register('no-such-key', chain)).rejects.toThrow('vc_issuer_key_not_found');
      await expect(register('  ', chain)).rejects.toThrow('invalid_kid');

      // An emergency rotation revokes the key; a chain can no longer be attached to it.
      await keyManager.revokeVcIssuerKeyRpc(key.kid, 'key compromise suspected, rotated');
      await expect(register(key.kid, chain)).rejects.toThrow('vc_issuer_key_not_found');
    });

    it('does not send x5c for a credential without an exp', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      await register(key.kid, await issueChain(key.publicJWK));
      const without = await keyManager.signSDJWTIssuerRpc(vcPayload({ exp: undefined }));
      expect(decodeProtectedHeader(without.token).x5c).toBeUndefined();
      // An exp that is not a finite number is either refused by the JWT library or, if it is
      // signed, never earns a certificate chain.
      for (const exp of ['soon', Number.NaN, Number.POSITIVE_INFINITY]) {
        const signed = await keyManager.signSDJWTIssuerRpc(vcPayload({ exp })).catch(() => null);
        if (signed) expect(decodeProtectedHeader(signed.token).x5c).toBeUndefined();
      }
    });

    it('requires x5c when the caller asks, for both VC and status list signing', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      // No chain yet: the default signing falls back, the required signing refuses.
      await expect(keyManager.signSDJWTIssuerRpc(vcPayload())).resolves.toBeDefined();
      await expect(
        keyManager.signSDJWTIssuerRpc(vcPayload(), { requireX5c: true })
      ).rejects.toThrow('x5c_required');
      await expect(
        keyManager.signStatusListCredentialRpc(statusPayload(), { requireX5c: true })
      ).rejects.toThrow('x5c_required');

      const chain = await issueChain(key.publicJWK);
      await register(key.kid, chain);
      const vc = await keyManager.signSDJWTIssuerRpc(vcPayload(), { requireX5c: true });
      expect(decodeProtectedHeader(vc.token).x5c).toEqual(chain);
      const list = await keyManager.signStatusListCredentialRpc(statusPayload(), {
        requireX5c: true,
      });
      expect(decodeProtectedHeader(list.token).x5c).toEqual(chain);

      // The chain stops fitting: another host, or a credential that outlives the chain.
      await expect(
        keyManager.signSDJWTIssuerRpc(vcPayload({ iss: 'https://other.example.com' }), {
          requireX5c: true,
        })
      ).rejects.toThrow('x5c_required');
      const beyond = Math.floor(Date.now() / 1000) + 365 * 86400;
      await expect(
        keyManager.signSDJWTIssuerRpc(vcPayload({ exp: beyond }), { requireX5c: true })
      ).rejects.toThrow('x5c_required');
    });

    it('refuses malformed signing options', async () => {
      await keyManager.rotateECKeysRpc('ES256');
      for (const options of [
        { requireX5c: 'yes' },
        { other: true },
        null,
        'x',
        [],
        new Map([['requireX5c', true]]),
      ]) {
        await expect(keyManager.signSDJWTIssuerRpc(vcPayload(), options as never)).rejects.toThrow(
          'invalid_vc_signing_options'
        );
      }
    });

    it('stops sending x5c when the issuing CA leaves the allowlist', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      await register(key.kid, chain);
      expect(
        decodeProtectedHeader((await keyManager.signSDJWTIssuerRpc(vcPayload())).token).x5c
      ).toEqual(chain);

      env.VC_X5C_ISSUING_CA_SHA256 = 'b'.repeat(64);
      const after = await keyManager.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(after.token).x5c).toBeUndefined();
      await expect(
        keyManager.signSDJWTIssuerRpc(vcPayload(), { requireX5c: true })
      ).rejects.toThrow('x5c_required');
    });

    it('refuses chains outside the Authrim profile', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      await expect(
        register(key.kid, await issueChain(key.publicJWK, { leafCommonName: 'other.example.com' }))
      ).rejects.toThrow('leaf_subject_mismatch');
      await expect(
        register(key.kid, await issueChain(key.publicJWK, { caPathLength: 1 }))
      ).rejects.toThrow('issuing_ca_path_length');
      await expect(
        register(key.kid, await issueChain(key.publicJWK, { eku: true }))
      ).rejects.toThrow('extended_key_usage_not_allowed');
    });

    it('sends x5c on the Token Status List only, not on the legacy Bitstring Status List', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      await register(key.kid, chain);
      const now = Math.floor(Date.now() / 1000);
      const legacy = {
        iss: 'did:web:issuer.example.com',
        sub: 'https://issuer.example.com/vci/status/list-a',
        iat: now,
        exp: now + 3600,
        vc: {
          type: ['VerifiableCredential', 'BitstringStatusListCredential'],
          credentialSubject: {
            type: 'BitstringStatusList',
            statusPurpose: 'revocation',
            encodedList: 'encoded-list',
          },
        },
      };
      const token = await keyManager.signStatusListCredentialRpc(legacy);
      expect(decodeProtectedHeader(token.token).x5c).toBeUndefined();
      await expect(
        keyManager.signStatusListCredentialRpc(legacy, { requireX5c: true })
      ).rejects.toThrow('x5c_required');
      // The Token Status List of the same key still carries it.
      const list = await keyManager.signStatusListCredentialRpc(statusPayload());
      expect(decodeProtectedHeader(list.token).x5c).toEqual(chain);
    });

    it('refuses signing options that are not a plain record', async () => {
      await keyManager.rotateECKeysRpc('ES256');
      class Custom {
        requireX5c = true;
      }
      for (const options of [new Custom(), Object.create({ requireX5c: true }) as object]) {
        await expect(keyManager.signSDJWTIssuerRpc(vcPayload(), options as never)).rejects.toThrow(
          'invalid_vc_signing_options'
        );
      }
      // A record without a prototype is plain.
      const bare = Object.assign(Object.create(null) as object, { requireX5c: false });
      await expect(keyManager.signSDJWTIssuerRpc(vcPayload(), bare)).resolves.toBeDefined();
    });

    it('tells the certificate issuer which key needs a chain, and what the key already has', async () => {
      // The key is created on first use; it has no chain yet.
      const first = await keyManager.getVcSigningCertificateStateRpc();
      expect(first).toMatchObject({
        issuerHost: null,
        caSha256: null,
        chainNotAfter: null,
      });
      expect(first.publicJWK).not.toHaveProperty('d');
      expect(Object.keys(first.publicJWK).sort()).toEqual(['crv', 'kty', 'x', 'y']);

      const chain = await issueChain(first.publicJWK);
      const stored = await register(first.kid, chain);
      const after = await keyManager.getVcSigningCertificateStateRpc();
      expect(after).toMatchObject({ kid: first.kid, issuerHost: HOST });
      expect(after.chainNotAfter).toBe(stored.chainNotAfter);
      expect(after.caSha256).toMatch(/^[0-9a-f]{64}$/u);

      // After a rotation the new key is the one that needs a chain.
      const second = await keyManager.rotateECKeysRpc('ES256');
      const rotated = await keyManager.getVcSigningCertificateStateRpc();
      expect(rotated.kid).toBe(second.kid);
      expect(rotated.chainNotAfter).toBeNull();
    });

    it('never makes a revoked key active again, so its chain does not come back', async () => {
      const first = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(first.publicJWK);
      await register(first.kid, chain);
      const second = await keyManager.rotateECKeysRpc('ES256'); // the first key is now in overlap
      await keyManager.revokeVcIssuerKeyRpc(first.kid, 'key compromise suspected, revoked');

      await expect(keyManager.setActiveECKey(first.kid)).rejects.toThrow('EC key not found');
      const active = await keyManager.getActiveECKeyRpc('ES256');
      expect(active?.kid).toBe(second.kid);
      const token = await keyManager.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(token.token)).toMatchObject({ kid: second.kid });
      expect(decodeProtectedHeader(token.token).x5c).toBeUndefined();
    });

    it('does not sign with a chain whose storage failed, even in the same instance', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      vi.spyOn(state.storage, 'put').mockRejectedValueOnce(new Error('synthetic storage failure'));
      await expect(register(key.kid, chain)).rejects.toThrow('synthetic storage failure');

      const credential = await keyManager.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(credential.token).x5c).toBeUndefined();
      // The same chain registers once storage works again.
      await expect(register(key.kid, chain)).resolves.toMatchObject({ kid: key.kid });
    });

    it('lets a chained key be exported and restored, without the chain', async () => {
      const key = await keyManager.rotateECKeysRpc('ES256');
      const chain = await issueChain(key.publicJWK);
      await register(key.kid, chain);
      await keyManager.getExistingSecretRpc('field-mapping-hash');

      const exported = await keyManager.exportTenantBackupStateRpc();
      expect(JSON.stringify(exported)).not.toContain('certificateChain');
      expect(await keyManager.verifyTenantBackupStateRpc(exported)).toBe(true);

      const restoredState = new MockDurableObjectState();
      const restored = new KeyManager(restoredState as unknown as DurableObjectState, env);
      await restored.importTenantBackupStateRpc(exported);
      const credential = await restored.signSDJWTIssuerRpc(vcPayload());
      expect(decodeProtectedHeader(credential.token)).toMatchObject({ kid: key.kid });
      expect(decodeProtectedHeader(credential.token).x5c).toBeUndefined();
    });
  });

  describe('VC issuer public key retention', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const start = Date.UTC(2026, 9, 4);

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the public key of a normally retired key after the overlap is cleaned up', async () => {
      vi.useFakeTimers({ now: start });
      const first = await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + DAY / 2);
      const second = await keyManager.rotateECKeysRpc('ES256');

      let jwks = await keyManager.getVcIssuerJwksRpc();
      expect(jwks.keys.map((k) => k.kid).sort()).toEqual([first.kid, second.kid].sort());

      vi.setSystemTime(start + 3 * DAY);
      const third = await keyManager.rotateECKeysRpc('ES256');
      const status = await keyManager.getECStatusRpc();
      expect(status.keys.map((k) => k.kid)).not.toContain(first.kid);

      jwks = await keyManager.getVcIssuerJwksRpc();
      expect(jwks.keys.map((k) => k.kid)).toEqual(
        expect.arrayContaining([first.kid, second.kid, third.kid])
      );
      for (const k of jwks.keys) {
        expect(k).not.toHaveProperty('d');
        expect(k).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
      }
      const retired = jwks.keys.find((k) => k.kid === first.kid)!;
      await expect(importJWK(retired, 'ES256')).resolves.toBeDefined();
      // Retained keys are never offered for signing.
      await expect(keyManager.getActiveECKeyRpc('ES256')).resolves.toMatchObject({
        kid: third.kid,
      });
    });

    it('revokes a retained public key by kid so its credentials stop verifying', async () => {
      vi.useFakeTimers({ now: start });
      const first = await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 1000);
      await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 2 * DAY);
      await keyManager.rotateECKeysRpc('ES256');
      expect((await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).toContain(first.kid);

      await expect(
        keyManager.revokeVcIssuerKeyRpc(first.kid, 'leaked after rotation')
      ).resolves.toEqual({ revoked: true });
      expect((await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).not.toContain(
        first.kid
      );
      const exported = await keyManager.exportTenantBackupStateRpc();
      expect(exported.vcEc.retiredPublicKeys?.map((r) => r.kid) ?? []).not.toContain(first.kid);
    });

    it('revokes an overlap key at once and never retains it', async () => {
      vi.useFakeTimers({ now: start });
      const first = await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 1000);
      await keyManager.rotateECKeysRpc('ES256');

      await expect(
        keyManager.revokeVcIssuerKeyRpc(first.kid, 'overlap key compromised')
      ).resolves.toEqual({ revoked: true });
      expect((await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).not.toContain(
        first.kid
      );

      vi.setSystemTime(start + 3 * DAY);
      await keyManager.rotateECKeysRpc('ES256');
      expect((await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).not.toContain(
        first.kid
      );
    });

    it('replaces an active key through emergency rotation when revoked by kid', async () => {
      const active = await keyManager.rotateECKeysRpc('ES256');
      const result = await keyManager.revokeVcIssuerKeyRpc(active.kid, 'active key compromised');

      expect(result.revoked).toBe(true);
      expect(result.replacedBy).toBeDefined();
      expect(result.replacedBy).not.toBe(active.kid);
      await expect(keyManager.getActiveECKeyRpc('ES256')).resolves.toMatchObject({
        kid: result.replacedBy,
      });
      expect((await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).not.toContain(
        active.kid
      );
    });

    it('reports unknown kids and refuses revocation without a reason', async () => {
      const active = await keyManager.rotateECKeysRpc('ES256');
      await expect(
        keyManager.revokeVcIssuerKeyRpc('unknown-kid', 'no such key here')
      ).resolves.toEqual({ revoked: false });
      await expect(keyManager.revokeVcIssuerKeyRpc(active.kid, 'short')).rejects.toThrow(
        'invalid_revocation_reason'
      );
      await expect(keyManager.getActiveECKeyRpc('ES256')).resolves.toMatchObject({
        kid: active.kid,
      });
    });

    it('refuses revocation reasons the DR backup could not carry', async () => {
      const active = await keyManager.rotateECKeysRpc('ES256');
      await expect(keyManager.revokeVcIssuerKeyRpc(active.kid, 'x'.repeat(2049))).rejects.toThrow(
        'invalid_revocation_reason'
      );
      await expect(keyManager.getActiveECKeyRpc('ES256')).resolves.toMatchObject({
        kid: active.kid,
      });
    });

    it('prunes a retained key after retainUntil', async () => {
      vi.useFakeTimers({ now: start });
      const first = await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 1000);
      await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 2 * DAY);
      await keyManager.rotateECKeysRpc('ES256');
      expect((await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).toContain(first.kid);

      // Hidden from the JWKS as soon as retainUntil passes, and removed at the next cleanup.
      vi.setSystemTime(start + 2 * DAY + 366 * DAY);
      expect((await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).not.toContain(
        first.kid
      );
      await keyManager.rotateECKeysRpc('ES256');
      const exported = await keyManager.exportTenantBackupStateRpc();
      expect(exported.vcEc.retiredPublicKeys?.map((r) => r.kid) ?? []).not.toContain(first.kid);
    });

    it('never retains a key revoked by emergency rotation and drops a retained copy', async () => {
      vi.useFakeTimers({ now: start });
      const first = await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 1000);
      await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 2 * DAY);
      const third = await keyManager.rotateECKeysRpc('ES256');
      expect((await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).toContain(first.kid);

      // Emergency-revoke the active key: it is excluded, and a retained copy would be removed.
      await keyManager.emergencyRotateECKeysRpc('ES256', 'compromised');
      let kids = (await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid);
      expect(kids).not.toContain(third.kid);
      expect(kids).toContain(first.kid);

      // Revoked keys cleaned up later never enter the retained list.
      vi.setSystemTime(start + 400 * DAY);
      await keyManager.rotateECKeysRpc('ES256');
      kids = (await keyManager.getVcIssuerJwksRpc()).keys.map((k) => k.kid);
      expect(kids).not.toContain(third.kid);

      // A retained copy with the revoked kid is removed on emergency revocation.
      const snapshot = await keyManager.exportTenantBackupStateRpc();
      const active = snapshot.vcEc.keys.find((k) => k.status === 'active')!;
      const seeded = structuredClone(state.storage.map.get('ecState')) as {
        retiredPublicKeys?: unknown[];
      };
      seeded.retiredPublicKeys = [
        ...(seeded.retiredPublicKeys ?? []),
        {
          kid: active.kid,
          algorithm: 'ES256',
          publicJWK: active.publicJWK,
          retiredAt: Date.now(),
          retainUntil: Date.now() + 365 * DAY,
        },
      ];
      state.storage.map.set('ecState', seeded);
      const reloaded = new KeyManager(state as unknown as DurableObjectState, env);
      await reloaded.emergencyRotateECKeysRpc('ES256', 'compromised again');
      expect((await reloaded.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).not.toContain(
        active.kid
      );
    });

    it('tolerates stored state without the retained list and exports it consistently', async () => {
      const snapshot = await createPortableSnapshot();
      await keyManager.importTenantBackupStateRpc(snapshot);
      const jwks = await keyManager.getVcIssuerJwksRpc();
      expect(jwks.keys.map((k) => k.kid)).toEqual(['vc-backup-key']);
      await expect(keyManager.verifyTenantBackupStateRpc(snapshot)).resolves.toBe(true);
    });

    it('round-trips retained public keys through backup export, import and verify', async () => {
      vi.useFakeTimers({ now: start });
      const first = await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 1000);
      await keyManager.rotateECKeysRpc('ES256');
      vi.setSystemTime(start + 2 * DAY);
      await keyManager.rotateECKeysRpc('ES256');

      const exported = await keyManager.exportTenantBackupStateRpc();
      expect(exported.vcEc.retiredPublicKeys?.map((r) => r.kid)).toEqual([first.kid]);
      expect(JSON.stringify(exported.vcEc.retiredPublicKeys)).not.toContain('"d"');
      await expect(keyManager.verifyTenantBackupStateRpc(exported)).resolves.toBe(true);

      const target = new KeyManager(
        new MockDurableObjectState() as unknown as DurableObjectState,
        env
      );
      await target.importTenantBackupStateRpc(exported, { replaceBootstrapKey: true });
      expect((await target.getVcIssuerJwksRpc()).keys.map((k) => k.kid)).toContain(first.kid);
    });

    it('refuses a rotation that would push unexpired retained keys past the cap', async () => {
      vi.useFakeTimers({ now: start });
      const active = await keyManager.rotateECKeysRpc('ES256');
      const exported = await keyManager.exportTenantBackupStateRpc();
      const { kty, crv, x, y } = active.publicJWK;
      const retained = (count: number) =>
        Array.from({ length: count }, (_, index) => {
          const kid = `retired-${index}`;
          return {
            kid,
            algorithm: 'ES256' as const,
            publicJWK: { kid, kty, crv, x, y, alg: 'ES256', use: 'sig' },
            retiredAt: start - DAY,
            retainUntil: start + 300 * DAY,
          };
        });
      const seeded = (count: number) => {
        const target = new KeyManager(
          new MockDurableObjectState() as unknown as DurableObjectState,
          env
        );
        return target
          .importTenantBackupStateRpc(
            { ...exported, vcEc: { ...exported.vcEc, retiredPublicKeys: retained(count) } },
            { replaceBootstrapKey: true }
          )
          .then(() => target);
      };

      // One live key plus 1023 retained keys: the next rotation would retain 1024 + 1.
      const full = await seeded(1023);
      await expect(full.rotateECKeysRpc('ES256')).rejects.toThrow(
        'vc_issuer_key_retention_cap_reached'
      );
      expect((await full.getVcIssuerJwksRpc()).keys).toHaveLength(1024);
      await expect(full.getActiveECKeyRpc('ES256')).resolves.toMatchObject({ kid: active.kid });

      const roomy = await seeded(1022);
      await expect(roomy.rotateECKeysRpc('ES256')).resolves.toMatchObject({ status: 'active' });
    });
  });
});
