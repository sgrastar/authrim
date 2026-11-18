import { X509Certificate } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSigningKeyCache,
  exportSigningKeyWithPrivateMaterial,
  extractPublicKeyFromCertificate,
  generateSelfSignedCertificate,
  getKeyManagerSecret,
  getSigningCertificate,
  getSigningKey,
  importPrivateKey,
  importSigningKeyWithPrivateMaterial,
  resolveSAMLCertificateValidity,
  rotateSigningKeyWithCertificate,
  samlCertificateValidityProblem,
} from '../key-utils';

interface TestKeyMaterial {
  publicJwk: JsonWebKey;
  privateKeyPem: string;
}

let keyMaterial: TestKeyMaterial;

async function generateKeyMaterial(): Promise<TestKeyMaterial> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const [publicJwk, privateKeyPkcs8] = await Promise.all([
    crypto.subtle.exportKey('jwk', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  ]);
  return {
    publicJwk,
    privateKeyPem: formatPem('PRIVATE KEY', arrayBufferToBase64(new Uint8Array(privateKeyPkcs8))),
  };
}

function createKeyManagerStub(initialCertificate?: string) {
  const keyData = {
    kid: 'saml-key-1',
    privatePEM: keyMaterial.privateKeyPem,
    publicJWK: keyMaterial.publicJwk,
    createdAt: 1_700_000_000_000,
  };
  // Mirrors KeyManager: rotateKeys makes the new key active, certificates are stored per kid.
  const state: { activeKid: string; certificates: Map<string, string>; rotations: number } = {
    activeKid: keyData.kid,
    certificates: new Map(initialCertificate ? [[keyData.kid, initialCertificate]] : []),
    rotations: 0,
  };
  const activeKey = () => ({
    ...keyData,
    kid: state.activeKid,
    certificatePEM: state.certificates.get(state.activeKid),
  });
  const stub = {
    getActiveKeyWithPrivateRpc: vi.fn<() => Promise<Record<string, unknown> | null>>(async () =>
      activeKey()
    ),
    rotateKeys: vi.fn(async () => {
      state.rotations += 1;
      state.activeKid = `saml-key-${state.rotations + 1}`;
      return activeKey();
    }),
    storeCertificateForKey: vi.fn<
      (body: { kid: string; certificatePEM: string }) => Promise<Record<string, unknown>>
    >(async (body) => {
      state.certificates.set(body.kid, body.certificatePEM);
      return { ...keyData, kid: body.kid, certificatePEM: body.certificatePEM };
    }),
    importKey: vi.fn<(body: Record<string, unknown>) => Promise<void>>(async () => undefined),
    getOrCreateSecretRpc: vi.fn(async (secretRef: string) => ({
      secretRef,
      active: { kid: 'secret-1', value: 'secret-value', createdAt: 1 },
      updatedAt: 1,
    })),
  };
  const idFromName = vi.fn((name: string) => `id:${name}`);
  const env = { KEY_MANAGER: { idFromName, get: vi.fn(() => stub) } };
  return { env, stub, state, idFromName };
}

beforeEach(async () => {
  keyMaterial ??= await generateKeyMaterial();
  clearSigningKeyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('getSigningKey / getSigningCertificate', () => {
  it('rejects an incomplete signing key from an alternate runtime', async () => {
    const env = {
      SAML_RUNTIME_PORTS: {
        signing: {
          getKey: vi.fn(async () => ({ kid: 'k', privateKeyPem: 'p', publicKeyPem: 'pub' })),
        },
      },
    };

    await expect(getSigningKey(env as never, 'tenant-a')).rejects.toThrow(
      'SAML runtime signing key is incomplete'
    );
  });

  it('rejects a missing certificate from an alternate runtime', async () => {
    const env = {
      SAML_RUNTIME_PORTS: {
        signing: { getKey: vi.fn(async () => ({ kid: 'k', privateKeyPem: 'p' })) },
      },
    };

    await expect(getSigningCertificate(env as never, 'tenant-a')).rejects.toThrow(
      'SAML runtime signing certificate is missing'
    );
  });

  it('uses the tenant default KeyManager instance when no keyRef is given', async () => {
    const { env, idFromName, stub } = createKeyManagerStub();

    const key = await getSigningKey(env as never, 'tenant-a');

    expect(idFromName).toHaveBeenCalledWith('tenant-a-v3');
    expect(key.kid).toBe('saml-key-1');
    expect(key.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(stub.storeCertificateForKey).toHaveBeenCalledTimes(1);
  });

  it('serves the cached key within the TTL and reloads after it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { env, stub } = createKeyManagerStub();

    await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' });
    await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' });
    expect(stub.getActiveKeyWithPrivateRpc).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-01-01T00:04:59Z'));
    await getSigningCertificate(env as never, 'tenant-a', { keyRef: 'ref-1' });
    expect(stub.getActiveKeyWithPrivateRpc).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' });
    expect(stub.getActiveKeyWithPrivateRpc).toHaveBeenCalledTimes(2);
  });

  it('keeps cache entries separate per tenant and keyRef', async () => {
    const { env, stub } = createKeyManagerStub();

    await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' });
    await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-2' });
    await getSigningKey(env as never, 'tenant-b', { keyRef: 'ref-1' });

    expect(stub.getActiveKeyWithPrivateRpc).toHaveBeenCalledTimes(3);
  });

  it('clearSigningKeyCache forces the next lookup to hit KeyManager', async () => {
    const { env, stub } = createKeyManagerStub();

    await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' });
    clearSigningKeyCache();
    await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' });

    expect(stub.getActiveKeyWithPrivateRpc).toHaveBeenCalledTimes(2);
  });

  it('rotates keys when KeyManager has no active key', async () => {
    const { env, stub } = createKeyManagerStub();
    stub.getActiveKeyWithPrivateRpc.mockResolvedValueOnce(null);

    const key = await getSigningKey(env as never, 'tenant-a', {
      keyRef: 'ref-1',
      certificateOptions: { publicKeySizeBits: 3072 },
    });

    expect(stub.rotateKeys).toHaveBeenCalledWith({ modulusLength: 3072 });
    expect(key.kid).toBe('saml-key-2');
  });

  it('reuses a certificate already stored on the key without generating a new one', async () => {
    const { env, stub } = createKeyManagerStub(
      '-----BEGIN CERTIFICATE-----\nstored\n-----END CERTIFICATE-----'
    );

    const certificate = await getSigningCertificate(env as never, 'tenant-a', { keyRef: 'ref-1' });

    expect(certificate).toContain('stored');
    expect(stub.storeCertificateForKey).not.toHaveBeenCalled();
  });

  it('fails when KeyManager does not return the stored certificate', async () => {
    const { env, stub } = createKeyManagerStub();
    stub.storeCertificateForKey.mockResolvedValueOnce({ kid: 'saml-key-1' });

    await expect(getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' })).rejects.toThrow(
      'KeyManager did not return stored SAML signing certificate'
    );
  });

  it('rejects an empty tenant id', async () => {
    const { env } = createKeyManagerStub();

    await expect(getSigningKey(env as never, '')).rejects.toThrow();
    await expect(getSigningCertificate(env as never, '')).rejects.toThrow();
  });
});

describe('getKeyManagerSecret', () => {
  it('reads the secret from the KeyManager named by secretRef', async () => {
    const { env, idFromName, stub } = createKeyManagerStub();

    const secret = await getKeyManagerSecret(env as never, 'tenant-a', {
      secretRef: 'tenant:tenant-a:saml:pairwise',
    });

    expect(idFromName).toHaveBeenCalledWith('tenant:tenant-a:saml:pairwise');
    expect(stub.getOrCreateSecretRpc).toHaveBeenCalledWith('tenant:tenant-a:saml:pairwise');
    expect(secret.active.value).toBe('secret-value');
  });
});

describe('rotateSigningKeyWithCertificate', () => {
  it('rotates the key, stores a fresh certificate and invalidates the cache', async () => {
    const { env, stub, idFromName } = createKeyManagerStub();
    await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' });

    const rotated = await rotateSigningKeyWithCertificate(env as never, 'tenant-a', {
      keyRef: 'ref-1',
      certificateSubject: { commonName: 'Rotated Signing' },
      certificateOptions: { publicKeySizeBits: 4096 },
    });

    expect(idFromName).toHaveBeenLastCalledWith('ref-1');
    expect(stub.rotateKeys).toHaveBeenCalledWith({ modulusLength: 4096 });
    expect(rotated).toMatchObject({ keyRef: 'ref-1', kid: 'saml-key-2' });
    expect(new X509Certificate(rotated.certificate).subject).toContain('CN=Rotated Signing');

    const reloaded = await getSigningKey(env as never, 'tenant-a', { keyRef: 'ref-1' });
    expect(stub.getActiveKeyWithPrivateRpc).toHaveBeenCalledTimes(2);
    expect(reloaded.kid).toBe('saml-key-2');
    expect(await getSigningCertificate(env as never, 'tenant-a', { keyRef: 'ref-1' })).toBe(
      rotated.certificate
    );
  });
});

describe('exportSigningKeyWithPrivateMaterial / importSigningKeyWithPrivateMaterial', () => {
  it('exports the key with a computed certificate thumbprint', async () => {
    const { env } = createKeyManagerStub();

    const exported = await exportSigningKeyWithPrivateMaterial(env as never, 'tenant-a', {
      keyRef: 'ref-1',
    });

    expect(exported).toMatchObject({
      keyRef: 'ref-1',
      kid: 'saml-key-1',
      privateKeyPem: keyMaterial.privateKeyPem,
      createdAt: 1_700_000_000_000,
    });
    expect(exported.certificate).toContain('-----BEGIN CERTIFICATE-----');
    expect(exported.certificateSha256Thumbprint).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('imports the key as active and computes a thumbprint when none is supplied', async () => {
    const { env, stub } = createKeyManagerStub();
    const certificate = await generateSelfSignedCertificate(
      keyMaterial.publicJwk,
      keyMaterial.privateKeyPem
    );

    await importSigningKeyWithPrivateMaterial(env as never, 'tenant-a', {
      keyRef: 'ref-1',
      kid: 'imported-1',
      publicJWK: keyMaterial.publicJwk,
      privateKeyPem: keyMaterial.privateKeyPem,
      certificate,
      createdAt: 42,
    });

    expect(stub.importKey).toHaveBeenCalledTimes(1);
    const body = stub.importKey.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      kid: 'imported-1',
      status: 'active',
      createdAt: 42,
      certificatePEM: certificate,
    });
    expect(body?.certificateSha256Thumbprint).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('keeps a supplied certificate thumbprint on import', async () => {
    const { env, stub } = createKeyManagerStub();

    await importSigningKeyWithPrivateMaterial(env as never, 'tenant-a', {
      keyRef: 'ref-1',
      kid: 'imported-1',
      publicJWK: keyMaterial.publicJwk,
      privateKeyPem: keyMaterial.privateKeyPem,
      certificate: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
      certificateSha256Thumbprint: 'given-thumbprint',
    });

    expect(stub.importKey.mock.calls[0]?.[0]?.certificateSha256Thumbprint).toBe('given-thumbprint');
  });
});

describe('generateSelfSignedCertificate validity and names', () => {
  it('encodes the requested validity window', async () => {
    const validFrom = Date.UTC(2026, 0, 1, 0, 0, 0);
    const validTo = Date.UTC(2031, 0, 1, 0, 0, 0);

    const pem = await generateSelfSignedCertificate(
      keyMaterial.publicJwk,
      keyMaterial.privateKeyPem,
      undefined,
      { validFrom, validTo }
    );
    const certificate = new X509Certificate(pem);

    expect(new Date(certificate.validFrom).getTime()).toBe(validFrom);
    expect(new Date(certificate.validTo).getTime()).toBe(validTo);
  });

  it('rejects validTo that is not later than validFrom', async () => {
    const validFrom = Date.UTC(2026, 0, 1);

    await expect(
      generateSelfSignedCertificate(keyMaterial.publicJwk, keyMaterial.privateKeyPem, undefined, {
        validFrom,
        validTo: validFrom,
      })
    ).rejects.toThrow('SAML signing certificate validTo must be later than validFrom');
  });

  it('rejects validity years outside the UTCTime range', async () => {
    await expect(
      generateSelfSignedCertificate(keyMaterial.publicJwk, keyMaterial.privateKeyPem, undefined, {
        validFrom: Date.UTC(2026, 0, 1),
        validTo: Date.UTC(2050, 0, 1),
      })
    ).rejects.toThrow('UTCTime only supports years from 1950 to 2049');
  });

  it('applies the default subject when fields are blank and truncates the country code', async () => {
    const pem = await generateSelfSignedCertificate(
      keyMaterial.publicJwk,
      keyMaterial.privateKeyPem,
      { countryName: 'jpn', organizationName: '  ', commonName: '\u0000\u0001' }
    );
    const certificate = new X509Certificate(pem);

    expect(certificate.subject).toContain('C=JP');
    expect(certificate.subject).toContain('O=Authrim');
    expect(certificate.subject).toContain('CN=Authrim SAML Signing');
  });

  it.each([
    ['https://example.test', 'scheme separator'],
    ['example.test/path', 'slash'],
    ['192.168.0.1', 'IPv4 literal'],
    ['*.example.test', 'wildcard'],
    ['bad_label.example.test', 'underscore label'],
    ['-leading.example.test', 'leading hyphen'],
    ['trailing-.example.test', 'trailing hyphen'],
    ['double..dot.example.test', 'empty label'],
    [`${'a'.repeat(64)}.example.test`, 'label longer than 63'],
    ['   ', 'blank'],
  ])('drops invalid DNS SAN %s (%s) and keeps valid ones', async (invalid) => {
    const pem = await generateSelfSignedCertificate(
      keyMaterial.publicJwk,
      keyMaterial.privateKeyPem,
      undefined,
      { subjectAlternativeNames: { dnsNames: [invalid, ' Valid.Example.TEST\u0007 '] } }
    );
    const certificate = new X509Certificate(pem);

    expect(certificate.subjectAltName).toBe('DNS:valid.example.test');
  });

  it('omits the SAN extension when every DNS name is invalid', async () => {
    const pem = await generateSelfSignedCertificate(
      keyMaterial.publicJwk,
      keyMaterial.privateKeyPem,
      undefined,
      { subjectAlternativeNames: { dnsNames: ['*', ''] } }
    );

    expect(new X509Certificate(pem).subjectAltName).toBeUndefined();
  });

  it('never emits an all-zero serial number', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
      return array;
    });

    const pem = await generateSelfSignedCertificate(
      keyMaterial.publicJwk,
      keyMaterial.privateKeyPem
    );

    expect(new X509Certificate(pem).serialNumber).toBe('01');
  });

  it('keeps the serial number positive when the top bit is set', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xff);
      return array;
    });

    const pem = await generateSelfSignedCertificate(
      keyMaterial.publicJwk,
      keyMaterial.privateKeyPem
    );

    expect(new X509Certificate(pem).serialNumber).toBe('7F' + 'FF'.repeat(15));
  });
});

describe('certificate validity helpers', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('defaults to five minutes ago through ten years ahead', () => {
    const { notBefore, notAfter } = resolveSAMLCertificateValidity({}, now);

    expect(notBefore.toISOString()).toBe('2026-05-31T23:55:00.000Z');
    expect(notAfter.toISOString()).toBe('2036-06-01T00:00:00.000Z');
  });

  it('ignores non-finite bounds and keeps finite ones', () => {
    const { notBefore, notAfter } = resolveSAMLCertificateValidity(
      { validFrom: Number.NaN, validTo: Date.UTC(2030, 0, 1) },
      now
    );

    expect(notBefore.toISOString()).toBe('2026-05-31T23:55:00.000Z');
    expect(notAfter.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it.each([
    [{}, null],
    [{ validFrom: 8.64e15 + 1 }, 'invalid_date'],
    [{ validTo: Date.UTC(2050, 0, 1) }, 'unsupported_year'],
    [{ validFrom: Date.UTC(1949, 11, 31) }, 'unsupported_year'],
    [
      { validFrom: Date.UTC(2027, 0, 1), validTo: Date.UTC(2027, 0, 1) },
      'not_after_before_not_before',
    ],
    [
      { validFrom: Date.UTC(2027, 0, 2), validTo: Date.UTC(2027, 0, 1) },
      'not_after_before_not_before',
    ],
    [{ validFrom: Date.UTC(1950, 0, 1), validTo: Date.UTC(2049, 11, 31) }, null],
  ])('reports the validity problem for %j as %s', (options, expected) => {
    expect(samlCertificateValidityProblem(options, now)).toBe(expected);
  });
});

describe('extractPublicKeyFromCertificate / importPrivateKey', () => {
  it('imports a PEM public key', async () => {
    const { publicKeyPem } = await getSigningKey(createKeyManagerStub().env as never, 'tenant-a');

    const key = await extractPublicKeyFromCertificate(publicKeyPem);

    expect(key.type).toBe('public');
    expect(key.usages).toEqual(['verify']);
  });

  it('rejects an X.509 certificate because only SPKI input is supported', async () => {
    const pem = await generateSelfSignedCertificate(
      keyMaterial.publicJwk,
      keyMaterial.privateKeyPem
    );

    await expect(extractPublicKeyFromCertificate(pem)).rejects.toThrow(
      'Failed to extract public key from certificate'
    );
  });

  it('imports a PKCS#8 private key for signing only', async () => {
    const key = await importPrivateKey(keyMaterial.privateKeyPem);

    expect(key.type).toBe('private');
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['sign']);
  });
});

function arrayBufferToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function formatPem(label: string, base64: string): string {
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}
