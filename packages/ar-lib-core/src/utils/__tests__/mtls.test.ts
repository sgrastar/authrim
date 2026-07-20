import { describe, expect, it } from 'vitest';
import { getPresentedClientCertificateThumbprint, validateClientCertificateBinding } from '../mtls';
import { arrayBufferToBase64Url } from '../crypto';

function requestWithCertificate(encoded?: string): Request {
  const request = new Request('https://issuer.example/token', {
    headers: {
      'Client-Cert': ':ZmFrZS1zcG9vZg==:',
      'X-Client-Cert': 'spoofed',
    },
  });
  Object.defineProperty(request, 'cf', {
    value: encoded
      ? {
          tlsClientAuth: {
            certPresented: '1',
            certRFC9440: `:${encoded}:`,
            certRFC9440TooLarge: '0',
          },
        }
      : undefined,
    configurable: true,
  });
  return request;
}

function requestWithFingerprint(fingerprint?: string): Request {
  const request = requestWithCertificate();
  Object.defineProperty(request, 'cf', {
    value: fingerprint
      ? {
          tlsClientAuth: {
            certPresented: '1',
            certFingerprintSHA256: fingerprint,
          },
        }
      : undefined,
    configurable: true,
  });
  return request;
}

describe('RFC 8705 client certificate binding', () => {
  it('ignores spoofable certificate headers when Cloudflare did not present a certificate', async () => {
    await expect(getPresentedClientCertificateThumbprint(requestWithCertificate())).resolves.toBe(
      undefined
    );
  });

  it('matches the Cloudflare-presented leaf certificate to the registered x5c certificate', async () => {
    const certificate = btoa('test-leaf-certificate');
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-leaf-certificate'))
    );
    const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const expected = arrayBufferToBase64Url(digest);
    await expect(
      getPresentedClientCertificateThumbprint(requestWithFingerprint(fingerprint))
    ).resolves.toBe(expected);
    await expect(
      validateClientCertificateBinding(requestWithFingerprint(fingerprint), {
        jwks: { keys: [{ kty: 'RSA', n: 'n', e: 'AQAB', x5c: [certificate] }] },
      })
    ).resolves.toEqual({ valid: true, thumbprint: expected });
  });

  it('rejects malformed Cloudflare SHA-256 fingerprints', async () => {
    await expect(
      getPresentedClientCertificateThumbprint(requestWithFingerprint('not-a-sha256-fingerprint'))
    ).resolves.toBeUndefined();
  });

  it('rejects a certificate registered to a different client', async () => {
    await expect(
      validateClientCertificateBinding(requestWithCertificate(btoa('presented')), {
        jwks: { keys: [{ kty: 'RSA', n: 'n', e: 'AQAB', x5c: [btoa('registered')] }] },
      })
    ).resolves.toEqual({ valid: false, error: 'certificate_invalid' });
  });

  it('rejects malformed or oversized RFC 9440 certificate values', async () => {
    const malformed = requestWithCertificate('%%%');
    await expect(getPresentedClientCertificateThumbprint(malformed)).resolves.toBeUndefined();

    const oversized = requestWithCertificate(btoa('x'.repeat(10 * 1024 + 1)));
    await expect(getPresentedClientCertificateThumbprint(oversized)).resolves.toBeUndefined();
  });
});
