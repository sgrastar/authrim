/**
 * Key Management Utilities for SAML 2.0
 *
 * Provides functions to interact with KeyManager Durable Object
 * and convert keys between formats (JWK, PEM, X.509).
 */

import type { Env } from '@authrim/ar-lib-core';
import type { JWK } from 'jose';
import { importSPKI, exportSPKI } from 'jose';
import { requireSAMLTenantId } from './tenant';

/**
 * Cached signing key data
 */
interface SigningKeyCache {
  privateKeyPem: string;
  publicKeyPem: string;
  certificate: string;
  kid: string;
  cachedAt: number;
}

interface KeyManagerSigningKey {
  kid: string;
  privatePEM: string;
  publicJWK: JWK;
  createdAt?: number;
  status?: 'active' | 'overlap' | 'revoked';
  certificatePEM?: string;
  certificateCreatedAt?: number;
  certificateSha256Thumbprint?: string;
}

export interface SAMLExportedSigningKey {
  keyRef: string;
  kid: string;
  publicJWK: JWK;
  privateKeyPem: string;
  certificate: string;
  createdAt?: number;
  certificateCreatedAt?: number;
  certificateSha256Thumbprint?: string;
}

export interface SAMLSigningCertificateSubject {
  countryName?: string;
  stateOrProvinceName?: string;
  localityName?: string;
  organizationName?: string;
  organizationalUnitName?: string;
  commonName?: string;
}

export interface SAMLSigningCertificateSubjectAlternativeNames {
  dnsNames: string[];
}

export interface SAMLSigningCertificateCreationOptions {
  validFrom?: number;
  validTo?: number;
  publicKeyAlgorithm?: 'RSA';
  publicKeySizeBits?: 2048 | 3072 | 4096;
  subjectAlternativeNames?: SAMLSigningCertificateSubjectAlternativeNames;
}

export const DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT: Required<SAMLSigningCertificateSubject> = {
  countryName: '',
  stateOrProvinceName: '',
  localityName: '',
  organizationName: 'Authrim',
  organizationalUnitName: '',
  commonName: 'Authrim SAML Signing',
};

// Cache for signing key (5 minutes TTL), scoped by tenant
const signingKeyCache = new Map<string, SigningKeyCache>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface SigningKeyLookupOptions {
  keyRef?: string;
  certificateSubject?: SAMLSigningCertificateSubject;
  certificateOptions?: SAMLSigningCertificateCreationOptions;
}

export interface SecretLookupOptions {
  secretRef: string;
}

export interface KeyManagerSecret {
  secretRef: string;
  active: {
    kid: string;
    value: string;
    createdAt: number;
  };
  previous?: {
    kid: string;
    value: string;
    createdAt: number;
  };
  updatedAt: number;
}

/**
 * Get signing key from KeyManager
 */
export async function getSigningKey(
  env: Env,
  tenantId: string,
  options: SigningKeyLookupOptions = {}
): Promise<{ privateKeyPem: string; publicKeyPem: string; kid: string }> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML signing key tenant');
  const cacheKey = buildSigningKeyCacheKey(resolvedTenantId, options.keyRef);

  // Check cache
  const cached = signingKeyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return {
      privateKeyPem: cached.privateKeyPem,
      publicKeyPem: cached.publicKeyPem,
      kid: cached.kid,
    };
  }

  // Get from KeyManager
  const keyManagerId = env.KEY_MANAGER.idFromName(
    buildKeyManagerInstanceName(resolvedTenantId, options.keyRef)
  );
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  const response = await keyManager.fetch(
    new Request('https://key-manager/internal/active-with-private', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
      },
    })
  );

  if (!response.ok) {
    // If no active key, try to rotate
    if (response.status === 404) {
      const rotateResponse = await keyManager.fetch(
        new Request('https://key-manager/internal/rotate', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
          },
        })
      );

      if (!rotateResponse.ok) {
        throw new Error('Failed to generate signing key');
      }

      const rotateData = (await rotateResponse.json()) as {
        key: KeyManagerSigningKey;
      };
      const publicKeyPem = await jwkToPublicKeyPem(rotateData.key.publicJWK);
      const certificate = await getOrPersistSigningCertificate(keyManager, env.KEY_MANAGER_SECRET, {
        keyData: rotateData.key,
        certificateSubject: options.certificateSubject,
        certificateOptions: options.certificateOptions,
      });

      // Update cache
      signingKeyCache.set(cacheKey, {
        privateKeyPem: rotateData.key.privatePEM,
        publicKeyPem,
        certificate,
        kid: rotateData.key.kid,
        cachedAt: Date.now(),
      });

      return {
        privateKeyPem: signingKeyCache.get(cacheKey)!.privateKeyPem,
        publicKeyPem: signingKeyCache.get(cacheKey)!.publicKeyPem,
        kid: signingKeyCache.get(cacheKey)!.kid,
      };
    }

    throw new Error(`KeyManager error: ${response.status}`);
  }

  const keyData = (await response.json()) as KeyManagerSigningKey;
  const publicKeyPem = await jwkToPublicKeyPem(keyData.publicJWK);
  const certificate = await getOrPersistSigningCertificate(keyManager, env.KEY_MANAGER_SECRET, {
    keyData,
    certificateSubject: options.certificateSubject,
    certificateOptions: options.certificateOptions,
  });

  // Update cache
  signingKeyCache.set(cacheKey, {
    privateKeyPem: keyData.privatePEM,
    publicKeyPem,
    certificate,
    kid: keyData.kid,
    cachedAt: Date.now(),
  });

  return {
    privateKeyPem: signingKeyCache.get(cacheKey)!.privateKeyPem,
    publicKeyPem: signingKeyCache.get(cacheKey)!.publicKeyPem,
    kid: signingKeyCache.get(cacheKey)!.kid,
  };
}

/**
 * Get signing certificate from KeyManager
 * Returns X.509 certificate in PEM format
 */
export async function getSigningCertificate(
  env: Env,
  tenantId: string,
  options: SigningKeyLookupOptions = {}
): Promise<string> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML signing certificate tenant');
  const cacheKey = buildSigningKeyCacheKey(resolvedTenantId, options.keyRef);

  // Check cache
  const cached = signingKeyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.certificate;
  }

  // Get signing key (this will update cache)
  await getSigningKey(env, resolvedTenantId, options);

  const nextCached = signingKeyCache.get(cacheKey);
  if (!nextCached) {
    throw new Error('Failed to get signing certificate');
  }

  return nextCached.certificate;
}

export async function getKeyManagerSecret(
  env: Env,
  tenantId: string,
  options: SecretLookupOptions
): Promise<KeyManagerSecret> {
  requireSAMLTenantId(tenantId, 'SAML KeyManager secret tenant');
  const keyManagerId = env.KEY_MANAGER.idFromName(options.secretRef);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  const response = await keyManager.fetch(
    new Request(`https://key-manager/internal/secrets/${encodeURIComponent(options.secretRef)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
      },
    })
  );

  if (!response.ok) {
    throw new Error(`KeyManager secret error: ${response.status}`);
  }

  return (await response.json()) as KeyManagerSecret;
}

async function getOrPersistSigningCertificate(
  keyManager: Pick<DurableObjectStub, 'fetch'>,
  keyManagerSecret: string | undefined,
  options: {
    keyData: KeyManagerSigningKey;
    certificateSubject?: SAMLSigningCertificateSubject;
    certificateOptions?: SAMLSigningCertificateCreationOptions;
  }
): Promise<string> {
  const { keyData } = options;
  if (keyData.certificatePEM) {
    return keyData.certificatePEM;
  }

  if (!keyManagerSecret) {
    throw new Error('KEY_MANAGER_SECRET is required to store SAML signing certificate');
  }

  const certificatePEM = await generateSelfSignedCertificate(
    keyData.publicJWK,
    keyData.privatePEM,
    options.certificateSubject,
    options.certificateOptions
  );
  const response = await keyManager.fetch(
    new Request('https://key-manager/internal/certificate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyManagerSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kid: keyData.kid,
        certificatePEM,
        certificateCreatedAt: Date.now(),
        certificateSha256Thumbprint: await calculateCertificateThumbprint(certificatePEM),
      }),
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to store SAML signing certificate: ${response.status}`);
  }

  const storedKey = (await response.json()) as { certificatePEM?: string };
  if (!storedKey.certificatePEM) {
    throw new Error('KeyManager did not return stored SAML signing certificate');
  }

  return storedKey.certificatePEM;
}

export async function rotateSigningKeyWithCertificate(
  env: Env,
  tenantId: string,
  options: {
    keyRef: string;
    certificateSubject?: SAMLSigningCertificateSubject;
    certificateOptions?: SAMLSigningCertificateCreationOptions;
  }
): Promise<{ keyRef: string; kid: string; certificate: string }> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML signing key tenant');
  const keyManagerId = env.KEY_MANAGER.idFromName(options.keyRef);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  const rotateResponse = await keyManager.fetch(
    new Request('https://key-manager/internal/rotate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        modulusLength: options.certificateOptions?.publicKeySizeBits,
      }),
    })
  );

  if (!rotateResponse.ok) {
    throw new Error(`Failed to rotate SAML signing key: ${rotateResponse.status}`);
  }

  const rotateData = (await rotateResponse.json()) as { key: KeyManagerSigningKey };
  const certificate = await getOrPersistSigningCertificate(keyManager, env.KEY_MANAGER_SECRET, {
    keyData: rotateData.key,
    certificateSubject: options.certificateSubject,
    certificateOptions: options.certificateOptions,
  });

  signingKeyCache.delete(buildSigningKeyCacheKey(resolvedTenantId, options.keyRef));
  return {
    keyRef: options.keyRef,
    kid: rotateData.key.kid,
    certificate,
  };
}

export async function exportSigningKeyWithPrivateMaterial(
  env: Env,
  tenantId: string,
  options: {
    keyRef: string;
    certificateSubject?: SAMLSigningCertificateSubject;
    certificateOptions?: SAMLSigningCertificateCreationOptions;
  }
): Promise<SAMLExportedSigningKey> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML signing key tenant');
  const keyManagerId = env.KEY_MANAGER.idFromName(options.keyRef);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  const keyData = await getOrCreateKeyManagerSigningKey(keyManager, env.KEY_MANAGER_SECRET, {
    certificateSubject: options.certificateSubject,
    certificateOptions: options.certificateOptions,
  });
  const certificate = await getOrPersistSigningCertificate(keyManager, env.KEY_MANAGER_SECRET, {
    keyData,
    certificateSubject: options.certificateSubject,
    certificateOptions: options.certificateOptions,
  });

  signingKeyCache.set(buildSigningKeyCacheKey(resolvedTenantId, options.keyRef), {
    privateKeyPem: keyData.privatePEM,
    publicKeyPem: await jwkToPublicKeyPem(keyData.publicJWK),
    certificate,
    kid: keyData.kid,
    cachedAt: Date.now(),
  });

  return {
    keyRef: options.keyRef,
    kid: keyData.kid,
    publicJWK: keyData.publicJWK,
    privateKeyPem: keyData.privatePEM,
    certificate,
    createdAt: keyData.createdAt,
    certificateCreatedAt: keyData.certificateCreatedAt,
    certificateSha256Thumbprint:
      keyData.certificateSha256Thumbprint ?? (await calculateCertificateThumbprint(certificate)),
  };
}

export async function importSigningKeyWithPrivateMaterial(
  env: Env,
  tenantId: string,
  key: SAMLExportedSigningKey
): Promise<void> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML signing key tenant');
  const keyManagerId = env.KEY_MANAGER.idFromName(key.keyRef);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  const response = await keyManager.fetch(
    new Request('https://key-manager/internal/import-key', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kid: key.kid,
        publicJWK: key.publicJWK,
        privatePEM: key.privateKeyPem,
        status: 'active',
        createdAt: key.createdAt,
        certificatePEM: key.certificate,
        certificateCreatedAt: key.certificateCreatedAt,
        certificateSha256Thumbprint:
          key.certificateSha256Thumbprint ??
          (await calculateCertificateThumbprint(key.certificate)),
      }),
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to import SAML signing key: ${response.status}`);
  }
  signingKeyCache.delete(buildSigningKeyCacheKey(resolvedTenantId, key.keyRef));
}

async function getOrCreateKeyManagerSigningKey(
  keyManager: Pick<DurableObjectStub, 'fetch'>,
  keyManagerSecret: string | undefined,
  options: {
    certificateSubject?: SAMLSigningCertificateSubject;
    certificateOptions?: SAMLSigningCertificateCreationOptions;
  }
): Promise<KeyManagerSigningKey> {
  if (!keyManagerSecret) {
    throw new Error('KEY_MANAGER_SECRET is required to export SAML signing key material');
  }

  const response = await keyManager.fetch(
    new Request('https://key-manager/internal/active-with-private', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${keyManagerSecret}`,
      },
    })
  );
  if (response.ok) {
    return (await response.json()) as KeyManagerSigningKey;
  }
  if (response.status !== 404) {
    throw new Error(`KeyManager error: ${response.status}`);
  }

  const rotateResponse = await keyManager.fetch(
    new Request('https://key-manager/internal/rotate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyManagerSecret}`,
      },
    })
  );
  if (!rotateResponse.ok) {
    throw new Error('Failed to generate signing key');
  }
  const rotateData = (await rotateResponse.json()) as { key: KeyManagerSigningKey };
  await getOrPersistSigningCertificate(keyManager, keyManagerSecret, {
    keyData: rotateData.key,
    certificateSubject: options.certificateSubject,
    certificateOptions: options.certificateOptions,
  });
  return rotateData.key;
}

function buildSigningKeyCacheKey(tenantId: string, keyRef?: string): string {
  return keyRef ? `${tenantId}:${keyRef}` : tenantId;
}

function buildKeyManagerInstanceName(tenantId: string, keyRef?: string): string {
  return keyRef || `${tenantId}-v3`;
}

/**
 * Convert JWK to PEM public key format
 */
async function jwkToPublicKeyPem(jwk: JWK): Promise<string> {
  // Import JWK to CryptoKey (cast JWK to JsonWebKey for Web Crypto API compatibility)
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );

  // Export as SPKI
  const spki = await crypto.subtle.exportKey('spki', cryptoKey);
  const spkiBase64 = btoa(String.fromCharCode(...new Uint8Array(spki as ArrayBuffer)));

  // Format as PEM
  const lines = spkiBase64.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

/**
 * Generate a self-signed X.509 certificate from JWK public key
 *
 * Note: This generates a minimal certificate structure for SAML metadata.
 * In production, you may want to use pre-generated certificates or a
 * proper PKI infrastructure.
 *
 * The certificate structure follows X.509 v3 format with:
 * - Version: v3
 * - Serial Number: Random
 * - Signature Algorithm: SHA256WithRSAEncryption
 * - Issuer/Subject: CN=Authrim IdP
 * - Validity: 10 years
 * - Subject Public Key Info: RSA public key
 */
export async function generateSelfSignedCertificate(
  jwk: JWK,
  privateKeyPem: string,
  subject?: SAMLSigningCertificateSubject,
  options: SAMLSigningCertificateCreationOptions = {}
): Promise<string> {
  // Import JWK to CryptoKey (cast JWK to JsonWebKey for Web Crypto API compatibility)
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );

  // Export as SPKI (SubjectPublicKeyInfo)
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const tbsCertificate = buildSelfSignedCertificateTbs(
    new Uint8Array(spki as ArrayBuffer),
    normalizeCertificateSubject(subject),
    options
  );
  const privateKey = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    toArrayBuffer(tbsCertificate)
  );
  const signatureAlgorithm = buildSha256WithRsaAlgorithmIdentifier();
  const certificateDer = derSequence(
    tbsCertificate,
    signatureAlgorithm,
    derBitString(new Uint8Array(signature))
  );

  return formatPem('CERTIFICATE', arrayBufferToBase64(certificateDer));
}

function buildSelfSignedCertificateTbs(
  subjectPublicKeyInfo: Uint8Array,
  subject: Required<SAMLSigningCertificateSubject>,
  options: SAMLSigningCertificateCreationOptions = {}
): Uint8Array {
  const now = new Date();
  const notBefore = normalizeCertificateTime(options.validFrom, now.getTime() - 5 * 60 * 1000);
  const defaultNotAfter = new Date(now);
  defaultNotAfter.setUTCFullYear(defaultNotAfter.getUTCFullYear() + 10);
  const notAfter = normalizeCertificateTime(options.validTo, defaultNotAfter.getTime());
  if (notAfter.getTime() <= notBefore.getTime()) {
    throw new Error('SAML signing certificate validTo must be later than validFrom');
  }

  return derSequence(
    derExplicit(0, derInteger(2)), // X.509 v3
    derInteger(generateCertificateSerialNumber()),
    buildSha256WithRsaAlgorithmIdentifier(),
    buildCertificateName(subject),
    derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
    buildCertificateName(subject),
    subjectPublicKeyInfo,
    derExplicit(3, buildCertificateExtensions(options))
  );
}

function normalizeCertificateTime(value: number | undefined, fallback: number): Date {
  const timestamp = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return new Date(timestamp);
}

function normalizeCertificateSubject(
  subject: SAMLSigningCertificateSubject | undefined
): Required<SAMLSigningCertificateSubject> {
  return {
    countryName: sanitizeSubjectValue(subject?.countryName, 2).toUpperCase(),
    stateOrProvinceName: sanitizeSubjectValue(subject?.stateOrProvinceName, 128),
    localityName: sanitizeSubjectValue(subject?.localityName, 128),
    organizationName:
      sanitizeSubjectValue(subject?.organizationName, 128) ||
      DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT.organizationName,
    organizationalUnitName: sanitizeSubjectValue(subject?.organizationalUnitName, 128),
    commonName:
      sanitizeSubjectValue(subject?.commonName, 128) ||
      DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT.commonName,
  };
}

function sanitizeSubjectValue(value: string | undefined, maxLength: number): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function buildCertificateName(subject: Required<SAMLSigningCertificateSubject>): Uint8Array {
  const attributes: Uint8Array[] = [];
  if (subject.countryName) {
    attributes.push(
      derSet(derSequence(derObjectIdentifier('2.5.4.6'), derPrintableString(subject.countryName)))
    );
  }
  if (subject.stateOrProvinceName) {
    attributes.push(
      derSet(
        derSequence(derObjectIdentifier('2.5.4.8'), derUtf8String(subject.stateOrProvinceName))
      )
    );
  }
  if (subject.localityName) {
    attributes.push(
      derSet(derSequence(derObjectIdentifier('2.5.4.7'), derUtf8String(subject.localityName)))
    );
  }
  if (subject.organizationName) {
    attributes.push(
      derSet(derSequence(derObjectIdentifier('2.5.4.10'), derUtf8String(subject.organizationName)))
    );
  }
  if (subject.organizationalUnitName) {
    attributes.push(
      derSet(
        derSequence(derObjectIdentifier('2.5.4.11'), derUtf8String(subject.organizationalUnitName))
      )
    );
  }
  attributes.push(
    derSet(derSequence(derObjectIdentifier('2.5.4.3'), derUtf8String(subject.commonName)))
  );
  return derSequence(...attributes);
}

function buildCertificateExtensions(options: SAMLSigningCertificateCreationOptions): Uint8Array {
  const basicConstraints = derSequence(
    derObjectIdentifier('2.5.29.19'),
    derBoolean(true),
    derOctetString(derSequence())
  );
  const keyUsage = derSequence(
    derObjectIdentifier('2.5.29.15'),
    derBoolean(true),
    derOctetString(derBitString(new Uint8Array([0x80]), 7))
  );
  const subjectAlternativeNames = normalizeCertificateSubjectAlternativeNames(
    options.subjectAlternativeNames
  );

  return derSequence(
    basicConstraints,
    keyUsage,
    ...(subjectAlternativeNames.dnsNames.length
      ? [buildSubjectAlternativeNameExtension(subjectAlternativeNames)]
      : [])
  );
}

function normalizeCertificateSubjectAlternativeNames(
  value: SAMLSigningCertificateSubjectAlternativeNames | undefined
): { dnsNames: string[] } {
  const seen = new Set<string>();
  const dnsNames = Array.isArray(value?.dnsNames)
    ? value.dnsNames
        .map((name) => sanitizeDnsName(name))
        .filter((name): name is string => {
          if (!name || seen.has(name)) return false;
          seen.add(name);
          return true;
        })
    : [];
  return { dnsNames };
}

function sanitizeDnsName(value: string | undefined): string {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .toLowerCase()
    .slice(0, 253);
  if (!normalized || normalized.includes(':') || normalized.includes('/')) {
    return '';
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized) || normalized.includes('*')) {
    return '';
  }
  const labels = normalized.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    return '';
  }
  return normalized;
}

function buildSubjectAlternativeNameExtension(input: { dnsNames: string[] }): Uint8Array {
  const generalNames = derSequence(
    ...input.dnsNames.map((dnsName) => derTag(0x82, new TextEncoder().encode(dnsName)))
  );
  return derSequence(derObjectIdentifier('2.5.29.17'), derOctetString(generalNames));
}

function buildSha256WithRsaAlgorithmIdentifier(): Uint8Array {
  return derSequence(derObjectIdentifier('1.2.840.113549.1.1.11'), derNull());
}

function generateCertificateSerialNumber(): Uint8Array {
  const serial = new Uint8Array(16);
  crypto.getRandomValues(serial);
  serial[0] &= 0x7f;
  if (serial.every((value) => value === 0)) {
    serial[15] = 1;
  }
  return serial;
}

function derSequence(...values: Uint8Array[]): Uint8Array {
  return derTag(0x30, concatBytes(...values));
}

function derSet(...values: Uint8Array[]): Uint8Array {
  return derTag(0x31, concatBytes(...values));
}

function derExplicit(tagNumber: number, value: Uint8Array): Uint8Array {
  return derTag(0xa0 + tagNumber, value);
}

function derInteger(value: number | Uint8Array): Uint8Array {
  let bytes =
    typeof value === 'number'
      ? integerToBytes(value)
      : trimLeadingZeros(value.length === 0 ? new Uint8Array([0]) : value);
  if (bytes.length === 0) {
    bytes = new Uint8Array([0]);
  }
  if ((bytes[0] & 0x80) !== 0) {
    bytes = concatBytes(new Uint8Array([0]), bytes);
  }
  return derTag(0x02, bytes);
}

function derBoolean(value: boolean): Uint8Array {
  return derTag(0x01, new Uint8Array([value ? 0xff : 0x00]));
}

function derBitString(value: Uint8Array, unusedBits = 0): Uint8Array {
  return derTag(0x03, concatBytes(new Uint8Array([unusedBits]), value));
}

function derOctetString(value: Uint8Array): Uint8Array {
  return derTag(0x04, value);
}

function derNull(): Uint8Array {
  return derTag(0x05, new Uint8Array());
}

function derObjectIdentifier(oid: string): Uint8Array {
  const parts = oid.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Invalid object identifier: ${oid}`);
  }

  const [first, second, ...rest] = parts;
  const encoded = [40 * first + second, ...rest].flatMap(encodeOidArc);
  return derTag(0x06, new Uint8Array(encoded));
}

function derUtf8String(value: string): Uint8Array {
  return derTag(0x0c, new TextEncoder().encode(value));
}

function derPrintableString(value: string): Uint8Array {
  return derTag(0x13, new TextEncoder().encode(value));
}

function derUtcTime(value: Date): Uint8Array {
  const year = value.getUTCFullYear();
  if (year < 1950 || year > 2049) {
    throw new Error('UTCTime only supports years from 1950 to 2049');
  }
  const twoDigitYear = String(year % 100).padStart(2, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  const seconds = String(value.getUTCSeconds()).padStart(2, '0');
  return derTag(
    0x17,
    new TextEncoder().encode(`${twoDigitYear}${month}${day}${hours}${minutes}${seconds}Z`)
  );
}

function derTag(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function integerToBytes(value: number): Uint8Array {
  if (value === 0) {
    return new Uint8Array([0]);
  }

  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array(bytes);
}

function trimLeadingZeros(value: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === 0) {
    offset += 1;
  }
  return value.slice(offset);
}

function encodeOidArc(value: number): number[] {
  if (value === 0) {
    return [0];
  }

  const bytes: number[] = [];
  let remaining = value;
  bytes.unshift(remaining & 0x7f);
  remaining >>= 7;
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }
  return bytes;
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function arrayBufferToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function calculateCertificateThumbprint(certificatePEM: string): Promise<string> {
  const certificateDer = Uint8Array.from(atob(extractPemBase64(certificatePEM)), (c) =>
    c.charCodeAt(0)
  );
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(certificateDer));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function extractPemBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function formatPem(label: string, base64: string): string {
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

/**
 * Parse PEM certificate and extract public key
 */
export async function extractPublicKeyFromCertificate(certificatePem: string): Promise<CryptoKey> {
  // Remove PEM headers and decode base64
  const pemContents = certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  // Try importing as SPKI (public key)
  try {
    return await crypto.subtle.importKey(
      'spki',
      binaryDer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify']
    );
  } catch {
    // If SPKI fails, it might be an X.509 certificate
    // In that case, we would need to parse the certificate structure
    // For now, throw an error
    throw new Error('Failed to extract public key from certificate');
  }
}

/**
 * Import private key from PEM format
 */
export async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  // Remove PEM headers and decode
  const pemContents = privateKeyPem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Clear the signing key cache
 * Useful when keys are rotated
 */
export function clearSigningKeyCache(): void {
  signingKeyCache.clear();
}
