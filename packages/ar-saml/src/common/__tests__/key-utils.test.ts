import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSelfSignedCertificate, getSigningCertificate } from '../key-utils';

describe('SAML key utilities', () => {
  it('generates a parseable self-signed X.509 certificate for metadata', async () => {
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

    const certificatePem = await generateSelfSignedCertificate(
      publicJwk,
      formatPem('PRIVATE KEY', arrayBufferToBase64(new Uint8Array(privateKeyPkcs8)))
    );
    const certificate = new X509Certificate(certificatePem);

    expect(certificate.subject).toContain('CN=Authrim SAML Signing');
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.publicKey.asymmetricKeyType).toBe('rsa');
  });

  it('generates a self-signed certificate with a custom subject', async () => {
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

    const certificatePem = await generateSelfSignedCertificate(
      publicJwk,
      formatPem('PRIVATE KEY', arrayBufferToBase64(new Uint8Array(privateKeyPkcs8))),
      {
        countryName: 'JP',
        stateOrProvinceName: 'Tokyo',
        localityName: 'Chiyoda',
        organizationName: 'Example Org',
        organizationalUnitName: 'Identity',
        commonName: 'Example SAML Signing',
      }
    );
    const certificate = new X509Certificate(certificatePem);

    expect(certificate.subject).toContain('C=JP');
    expect(certificate.subject).toContain('ST=Tokyo');
    expect(certificate.subject).toContain('L=Chiyoda');
    expect(certificate.subject).toContain('O=Example Org');
    expect(certificate.subject).toContain('OU=Identity');
    expect(certificate.subject).toContain('CN=Example SAML Signing');
    expect(certificate.issuer).toBe(certificate.subject);
  });

  it('stores a generated certificate in KeyManager when a key has no certificate yet', async () => {
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
    const keyData = {
      kid: 'saml-key-1',
      privatePEM: formatPem('PRIVATE KEY', arrayBufferToBase64(new Uint8Array(privateKeyPkcs8))),
      publicJWK: publicJwk,
    };
    let storedCertificate: string | undefined;
    const certificateStoreCalls: unknown[] = [];

    const keyManager = {
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        if (path === '/internal/active-with-private') {
          return Response.json({ ...keyData, certificatePEM: storedCertificate });
        }
        if (path === '/internal/certificate') {
          const body = (await request.json()) as {
            kid: string;
            certificatePEM: string;
            certificateSha256Thumbprint?: string;
          };
          certificateStoreCalls.push(body);
          storedCertificate ??= body.certificatePEM;
          return Response.json({ ...keyData, certificatePEM: storedCertificate });
        }
        return new Response('not found', { status: 404 });
      },
    };
    const env = {
      KEY_MANAGER_SECRET: 'test-secret',
      KEY_MANAGER: {
        idFromName: () => 'stub-id',
        get: () => keyManager,
      },
    };

    const certificatePem = await getSigningCertificate(env as never, 'tenant-a', {
      keyRef: 'tenant:tenant-a:saml:sp:test:signing',
    });
    const certificate = new X509Certificate(certificatePem);

    expect(certificate.publicKey.asymmetricKeyType).toBe('rsa');
    expect(certificateStoreCalls).toHaveLength(1);
    expect(storedCertificate).toBe(certificatePem);
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
