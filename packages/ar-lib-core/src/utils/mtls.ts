import type { JWK } from 'jose';
import type { ClientMetadata } from '../types/oidc';
import { arrayBufferToBase64Url } from './crypto';

const MAX_CERTIFICATE_DER_BYTES = 10 * 1024;
const RFC9440_BINARY_VALUE = /^:([A-Za-z0-9+/=\r\n]+):$/u;

interface CloudflareTLSClientAuth {
  certPresented?: string;
  certFingerprintSHA256?: string;
  certRFC9440?: string;
  certRFC9440TooLarge?: string;
}

interface CloudflareRequestProperties {
  tlsClientAuth?: CloudflareTLSClientAuth;
}

export interface ClientCertificateBindingResult {
  valid: boolean;
  thumbprint?: string;
  error?: 'certificate_required' | 'certificate_invalid' | 'certificate_not_registered';
}

function decodeBase64Certificate(value: string): Uint8Array | null {
  const normalized = value.replace(/\s+/gu, '');
  if (!normalized || normalized.length > Math.ceil((MAX_CERTIFICATE_DER_BYTES * 4) / 3) + 4) {
    return null;
  }
  try {
    const binary = atob(normalized);
    if (!binary.length || binary.length > MAX_CERTIFICATE_DER_BYTES) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function certificateThumbprint(der: Uint8Array): Promise<string> {
  return arrayBufferToBase64Url(await crypto.subtle.digest('SHA-256', der));
}

function cloudflareFingerprintToThumbprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/:/gu, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) return undefined;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return arrayBufferToBase64Url(bytes);
}

export async function getPresentedClientCertificateThumbprint(
  request: Request
): Promise<string | undefined> {
  const cf = request.cf as CloudflareRequestProperties | undefined;
  const tls = cf?.tlsClientAuth;
  if (tls?.certPresented !== '1' || tls.certRFC9440TooLarge === '1') return undefined;
  const edgeThumbprint = cloudflareFingerprintToThumbprint(tls.certFingerprintSHA256);
  if (edgeThumbprint) return edgeThumbprint;
  if (typeof tls.certRFC9440 !== 'string') return undefined;
  const match = RFC9440_BINARY_VALUE.exec(tls.certRFC9440);
  if (!match) return undefined;
  const der = decodeBase64Certificate(match[1]);
  return der ? certificateThumbprint(der) : undefined;
}

export async function getRegisteredClientCertificateThumbprints(
  client: Pick<ClientMetadata, 'jwks'>
): Promise<Set<string>> {
  const thumbprints = new Set<string>();
  for (const key of (client.jwks?.keys ?? []) as JWK[]) {
    const encoded = Array.isArray(key.x5c) ? key.x5c[0] : undefined;
    if (typeof encoded !== 'string') continue;
    const der = decodeBase64Certificate(encoded);
    if (der) thumbprints.add(await certificateThumbprint(der));
  }
  return thumbprints;
}

export async function validateClientCertificateBinding(
  request: Request,
  client: Pick<ClientMetadata, 'jwks'>
): Promise<ClientCertificateBindingResult> {
  const thumbprint = await getPresentedClientCertificateThumbprint(request);
  if (!thumbprint) {
    return { valid: false, error: 'certificate_required' };
  }
  const registered = await getRegisteredClientCertificateThumbprints(client);
  if (registered.size === 0) {
    return { valid: false, error: 'certificate_not_registered' };
  }
  if (!registered.has(thumbprint)) {
    return { valid: false, error: 'certificate_invalid' };
  }
  return { valid: true, thumbprint };
}
