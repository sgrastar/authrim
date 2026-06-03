import type { Env } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import {
  buildEncryptedSAMLLocalSigningSecretDRBundle,
  buildSAMLLocalSigningSecretDRBundle,
  restoreEncryptedSAMLLocalSigningSecretDRBundle,
  restoreSAMLLocalSigningSecretDRBundle,
} from '../local-signing-dr-bundle';

describe('SAML local signing secret DR bundle', () => {
  it('exports encrypted and restores local SAML signing private keys', async () => {
    const sourceEnv = createEnv();
    const passphrase = 'correct horse battery staple';
    const encryptedBundle = await buildEncryptedSAMLLocalSigningSecretDRBundle(
      sourceEnv,
      'test',
      passphrase
    );
    const encryptedJson = JSON.stringify(encryptedBundle);

    expect(encryptedBundle.kind).toBe('authrim.saml_local_signing_secret_dr_bundle.encrypted.v1');
    expect(encryptedBundle.encrypted).toBe(true);
    expect(encryptedJson).not.toContain('BEGIN PRIVATE KEY');
    expect(encryptedJson).not.toContain('private-');

    const sourceBundle = await buildSAMLLocalSigningSecretDRBundle(sourceEnv, 'test');

    const restoreEnv = createEnv();
    const result = await restoreEncryptedSAMLLocalSigningSecretDRBundle(
      restoreEnv,
      'test',
      encryptedBundle,
      passphrase
    );
    expect(result.importedKeys).toBe(2);

    const restoredBundle = await buildSAMLLocalSigningSecretDRBundle(restoreEnv, 'test');
    expect(restoredBundle.keys.map((key) => key.kid).sort()).toEqual(
      sourceBundle.keys.map((key) => key.kid).sort()
    );
    expect(restoredBundle.keys.map((key) => key.privateKeyPem).sort()).toEqual(
      sourceBundle.keys.map((key) => key.privateKeyPem).sort()
    );
  });

  it('rejects an incorrect passphrase', async () => {
    const sourceEnv = createEnv();
    const encryptedBundle = await buildEncryptedSAMLLocalSigningSecretDRBundle(
      sourceEnv,
      'test',
      'correct horse battery staple'
    );

    await expect(
      restoreEncryptedSAMLLocalSigningSecretDRBundle(
        createEnv(),
        'test',
        encryptedBundle,
        'wrong horse battery staple'
      )
    ).rejects.toThrow('Failed to decrypt SAML DR bundle');
  });

  it('rejects signing key policy references that are not present in the bundle', async () => {
    const bundle = await buildSAMLLocalSigningSecretDRBundle(createEnv(), 'test');
    bundle.settings.signingKeyPolicies.idp = {
      active: {
        slot: 'active',
        keyRef: 'tenant:test:saml:idp:missing:signing',
        kid: 'missing',
        state: 'active',
      },
    };

    await expect(
      restoreSAMLLocalSigningSecretDRBundle(createEnv(), 'test', bundle)
    ).rejects.toThrow('SAML DR bundle signing key policy references a missing key');
  });
});

function createEnv(): Env {
  const settings = new Map<string, string>();
  const keyManager = new MockKeyManagerNamespace();
  return {
    ISSUER_URL: 'https://admin.test.authrim.com',
    KEY_MANAGER_SECRET: 'test-secret',
    SETTINGS: {
      get: async (key: string) => settings.get(key) ?? null,
      put: async (key: string, value: string) => {
        settings.set(key, value);
      },
    },
    KEY_MANAGER: keyManager,
  } as unknown as Env;
}

interface MockStoredKey {
  kid: string;
  publicJWK: Record<string, unknown>;
  privatePEM: string;
  createdAt: number;
  status: 'active';
  certificatePEM: string;
  certificateCreatedAt: number;
  certificateSha256Thumbprint: string;
}

class MockKeyManagerNamespace {
  private readonly stubs = new Map<string, MockKeyManagerStub>();

  idFromName(name: string): string {
    return name;
  }

  get(id: string): MockKeyManagerStub {
    let stub = this.stubs.get(id);
    if (!stub) {
      stub = new MockKeyManagerStub(id);
      this.stubs.set(id, stub);
    }
    return stub;
  }
}

class MockKeyManagerStub {
  private key: MockStoredKey | null = null;

  constructor(private readonly keyRef: string) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!request.headers.get('Authorization')?.includes('test-secret')) {
      return json({ error: 'Unauthorized' }, 401);
    }

    if (url.pathname === '/internal/active-with-private' && request.method === 'GET') {
      return this.key ? json(this.key) : json({ error: 'No active key found' }, 404);
    }

    if (url.pathname === '/internal/rotate' && request.method === 'POST') {
      const kid = `kid-${this.keyRef.replace(/[^a-zA-Z0-9]/g, '-')}`;
      this.key = {
        kid,
        publicJWK: {
          kty: 'RSA',
          kid,
          n: `modulus-${kid}`,
          e: 'AQAB',
        },
        privatePEM: ['-----BEGIN PRIVATE KEY-----', `private-${kid}`, '-----END PRIVATE KEY-----'].join(
          '\n'
        ),
        createdAt: 1770000000000,
        status: 'active',
        certificatePEM: ['-----BEGIN CERTIFICATE-----', 'QUJD', '-----END CERTIFICATE-----'].join(
          '\n'
        ),
        certificateCreatedAt: 1770000000000,
        certificateSha256Thumbprint: 'thumbprint',
      };
      return json({ success: true, key: this.key });
    }

    if (url.pathname === '/internal/certificate' && request.method === 'POST') {
      const body = (await request.json()) as {
        certificatePEM: string;
        certificateCreatedAt?: number;
        certificateSha256Thumbprint?: string;
      };
      if (!this.key) {
        return json({ error: 'No active key found' }, 404);
      }
      this.key.certificatePEM = body.certificatePEM;
      this.key.certificateCreatedAt = body.certificateCreatedAt ?? Date.now();
      this.key.certificateSha256Thumbprint = body.certificateSha256Thumbprint ?? '';
      return json(this.key);
    }

    if (url.pathname === '/internal/import-key' && request.method === 'POST') {
      const body = (await request.json()) as {
        kid: string;
        publicJWK: Record<string, unknown>;
        privatePEM: string;
        certificatePEM: string;
        certificateCreatedAt?: number;
        certificateSha256Thumbprint?: string;
      };
      this.key = {
        kid: body.kid,
        publicJWK: body.publicJWK,
        privatePEM: body.privatePEM,
        createdAt: 1770000000000,
        status: 'active',
        certificatePEM: body.certificatePEM,
        certificateCreatedAt: body.certificateCreatedAt ?? 1770000000000,
        certificateSha256Thumbprint: body.certificateSha256Thumbprint ?? '',
      };
      return json({ success: true, key: this.key });
    }

    return json({ error: 'Not found' }, 404);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
