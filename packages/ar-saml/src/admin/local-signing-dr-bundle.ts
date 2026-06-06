import type { Env, SAMLSigningKeyPolicy, SAMLSigningRole } from '@authrim/ar-lib-core';
import type { JWK } from 'jose';
import {
  DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT,
  exportSigningKeyWithPrivateMaterial,
  importSigningKeyWithPrivateMaterial,
  type SAMLExportedSigningKey,
  type SAMLSigningCertificateSubject,
} from '../common/key-utils';
import {
  getSAMLLocalEntityIds,
  getSAMLPublicSettings,
  normalizeSAMLInteractiveLoginUrlPolicy,
  normalizeSAMLEntityIdStyle,
  putSAMLPublicSettings,
  type SAMLInteractiveLoginUrlPolicy,
  type SAMLEntityIdStyle,
} from '../common/entity-id';
import { assertSAMLKeyRefTenantBound, buildSAMLSigningKeyRef } from '../common/saml-signing-keys';
import { requireSAMLTenantId } from '../common/tenant';

export const SAML_LOCAL_SIGNING_SECRET_DR_BUNDLE_KIND =
  'authrim.saml_local_signing_secret_dr_bundle.v1';
export const SAML_LOCAL_SIGNING_ENCRYPTED_DR_BUNDLE_KIND =
  'authrim.saml_local_signing_secret_dr_bundle.encrypted.v1';
const DR_BUNDLE_PASSPHRASE_MIN_LENGTH = 12;
const DR_BUNDLE_PASSPHRASE_MAX_LENGTH = 1024;
const DR_BUNDLE_KDF_MIN_ITERATIONS = 100_000;
const DR_BUNDLE_KDF_MAX_ITERATIONS = 100_000;
const DR_BUNDLE_KDF_ITERATIONS = 100_000;

export type SAMLDRBundleFailureStage =
  | 'validate_passphrase'
  | 'load_settings'
  | 'resolve_entity_ids'
  | 'export_signing_keys'
  | 'encrypt_bundle'
  | 'parse_encrypted_bundle'
  | 'decrypt_bundle'
  | 'validate_bundle'
  | 'import_signing_keys'
  | 'store_settings';

export class SAMLDRBundleOperationError extends Error {
  constructor(
    public readonly stage: SAMLDRBundleFailureStage,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'SAMLDRBundleOperationError';
  }
}

export interface SAMLLocalSigningSecretDRKey extends SAMLExportedSigningKey {
  role: SAMLSigningRole;
  slot: 'active' | 'next' | 'backup';
}

export interface SAMLLocalSigningSecretDRBundle {
  kind: typeof SAML_LOCAL_SIGNING_SECRET_DR_BUNDLE_KIND;
  version: 1;
  tenantId: string;
  generatedAt: string;
  sensitive: true;
  warning: string;
  settings: {
    entityIdStyle: SAMLEntityIdStyle;
    interactiveLoginUrlPolicy: SAMLInteractiveLoginUrlPolicy;
    certificateSubject: Required<SAMLSigningCertificateSubject>;
    signingKeyPolicies: {
      idp?: SAMLSigningKeyPolicy;
      sp?: SAMLSigningKeyPolicy;
    };
  };
  generated: Awaited<ReturnType<typeof getSAMLLocalEntityIds>>;
  keys: SAMLLocalSigningSecretDRKey[];
}

export interface SAMLLocalSigningEncryptedDRBundle {
  kind: typeof SAML_LOCAL_SIGNING_ENCRYPTED_DR_BUNDLE_KIND;
  version: 1;
  tenantId: string;
  generatedAt: string;
  encrypted: true;
  sensitive: true;
  warning: string;
  kdf: {
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    salt: string;
  };
  cipher: {
    name: 'AES-GCM';
    iv: string;
  };
  payload: string;
  payloadEncoding: 'base64';
}

export async function buildSAMLLocalSigningSecretDRBundle(
  env: Env,
  tenantId: string
): Promise<SAMLLocalSigningSecretDRBundle> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML local signing DR bundle tenant');
  const settings = await runSAMLDRBundleStage('load_settings', () =>
    getSAMLPublicSettings(env, resolvedTenantId)
  );
  const generated = await runSAMLDRBundleStage('resolve_entity_ids', () =>
    getSAMLLocalEntityIds(env, resolvedTenantId)
  );
  const keys = await runSAMLDRBundleStage('export_signing_keys', () =>
    collectSAMLSigningKeysForDRBundle(env, resolvedTenantId, settings)
  );

  return {
    kind: SAML_LOCAL_SIGNING_SECRET_DR_BUNDLE_KIND,
    version: 1,
    tenantId: resolvedTenantId,
    generatedAt: new Date().toISOString(),
    sensitive: true,
    warning:
      'This bundle contains SAML private signing keys. Store it offline and import it only into the intended tenant.',
    settings: {
      entityIdStyle: settings.entityIdStyle,
      interactiveLoginUrlPolicy: settings.interactiveLoginUrlPolicy,
      certificateSubject: settings.certificateSubject,
      signingKeyPolicies: settings.signingKeyPolicies,
    },
    generated,
    keys,
  };
}

export async function buildEncryptedSAMLLocalSigningSecretDRBundle(
  env: Env,
  tenantId: string,
  passphrase: unknown
): Promise<SAMLLocalSigningEncryptedDRBundle> {
  const normalizedPassphrase = runSAMLDRBundleSyncStage('validate_passphrase', () =>
    normalizeDRBundlePassphrase(passphrase)
  );
  const rawBundle = await buildSAMLLocalSigningSecretDRBundle(env, tenantId);
  return runSAMLDRBundleStage('encrypt_bundle', () =>
    encryptSAMLLocalSigningSecretDRBundle(rawBundle, normalizedPassphrase)
  );
}

export async function restoreSAMLLocalSigningSecretDRBundle(
  env: Env,
  tenantId: string,
  input: unknown
): Promise<{ importedKeys: number; restoredRoles: string[] }> {
  const resolvedTenantId = requireSAMLTenantId(tenantId, 'SAML local signing DR bundle tenant');
  const bundle = runSAMLDRBundleSyncStage('validate_bundle', () =>
    normalizeSAMLLocalSigningSecretDRBundle(input)
  );
  if (bundle.tenantId !== resolvedTenantId) {
    throw new SAMLDRBundleOperationError(
      'validate_bundle',
      'SAML DR bundle tenant does not match the current tenant'
    );
  }

  runSAMLDRBundleSyncStage('validate_bundle', () =>
    validateRestoredSigningKeyPolicies(bundle, resolvedTenantId)
  );

  await runSAMLDRBundleStage('import_signing_keys', async () => {
    for (const key of bundle.keys) {
      assertSAMLKeyRefTenantBound(key.keyRef, resolvedTenantId);
      await importSigningKeyWithPrivateMaterial(env, resolvedTenantId, key);
    }
  });

  await runSAMLDRBundleStage('store_settings', () =>
    putSAMLPublicSettings(env, resolvedTenantId, {
      entityIdStyle: bundle.settings.entityIdStyle,
      interactiveLoginUrlPolicy: bundle.settings.interactiveLoginUrlPolicy,
      certificateSubject: bundle.settings.certificateSubject,
      signingKeyPolicies: bundle.settings.signingKeyPolicies,
    })
  );

  return {
    importedKeys: bundle.keys.length,
    restoredRoles: ['idp', 'sp'].filter(
      (role) => bundle.settings.signingKeyPolicies[role as SAMLSigningRole]
    ),
  };
}

export async function restoreEncryptedSAMLLocalSigningSecretDRBundle(
  env: Env,
  tenantId: string,
  input: unknown,
  passphrase: unknown
): Promise<{ importedKeys: number; restoredRoles: string[] }> {
  const normalizedPassphrase = runSAMLDRBundleSyncStage('validate_passphrase', () =>
    normalizeDRBundlePassphrase(passphrase)
  );
  const bundle = await runSAMLDRBundleStage('decrypt_bundle', () =>
    decryptSAMLLocalSigningSecretDRBundle(input, normalizedPassphrase)
  );
  return restoreSAMLLocalSigningSecretDRBundle(env, tenantId, bundle);
}

async function encryptSAMLLocalSigningSecretDRBundle(
  bundle: SAMLLocalSigningSecretDRBundle,
  passphrase: string
): Promise<SAMLLocalSigningEncryptedDRBundle> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveDRBundleEncryptionKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, plaintext)
  );

  return {
    kind: SAML_LOCAL_SIGNING_ENCRYPTED_DR_BUNDLE_KIND,
    version: 1,
    tenantId: bundle.tenantId,
    generatedAt: bundle.generatedAt,
    encrypted: true,
    sensitive: true,
    warning:
      'This bundle is passphrase-encrypted and contains SAML private signing keys after decryption. Store it offline.',
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: DR_BUNDLE_KDF_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    cipher: {
      name: 'AES-GCM',
      iv: bytesToBase64(iv),
    },
    payload: bytesToBase64(ciphertext),
    payloadEncoding: 'base64',
  };
}

async function runSAMLDRBundleStage<T>(
  stage: SAMLDRBundleFailureStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SAMLDRBundleOperationError) {
      throw error;
    }
    throw new SAMLDRBundleOperationError(stage, getErrorMessage(error), { cause: error });
  }
}

function runSAMLDRBundleSyncStage<T>(stage: SAMLDRBundleFailureStage, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SAMLDRBundleOperationError) {
      throw error;
    }
    throw new SAMLDRBundleOperationError(stage, getErrorMessage(error), { cause: error });
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unknown error';
}

async function decryptSAMLLocalSigningSecretDRBundle(
  input: unknown,
  passphrase: string
): Promise<SAMLLocalSigningSecretDRBundle> {
  const encrypted = runSAMLDRBundleSyncStage('parse_encrypted_bundle', () =>
    normalizeEncryptedSAMLLocalSigningDRBundle(input)
  );
  const salt = base64ToBytes(encrypted.kdf.salt, 'salt');
  const iv = base64ToBytes(encrypted.cipher.iv, 'iv');
  const payload = base64ToBytes(encrypted.payload, 'payload');
  const key = await deriveDRBundleEncryptionKey(passphrase, salt, encrypted.kdf.iterations);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(payload)
    );
    return normalizeSAMLLocalSigningSecretDRBundle(
      JSON.parse(new TextDecoder().decode(plaintext)) as unknown
    );
  } catch (error) {
    throw new Error('Failed to decrypt SAML DR bundle. Check the passphrase and bundle file.');
  }
}

async function deriveDRBundleEncryptionKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = DR_BUNDLE_KDF_ITERATIONS
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function collectSAMLSigningKeysForDRBundle(
  env: Env,
  tenantId: string,
  settings: Awaited<ReturnType<typeof getSAMLPublicSettings>>
): Promise<SAMLLocalSigningSecretDRKey[]> {
  const keys: SAMLLocalSigningSecretDRKey[] = [];
  const seen = new Set<string>();
  for (const role of ['idp', 'sp'] as const) {
    const policy = settings.signingKeyPolicies[role] ?? {};
    const nextRefs = [policy.next, ...(policy.nextCandidates ?? [])]
      .map((reference) =>
        reference?.keyRef ? { role, slot: 'next' as const, keyRef: reference.keyRef } : null
      )
      .filter((ref): ref is { role: SAMLSigningRole; slot: 'next'; keyRef: string } =>
        Boolean(ref)
      );
    const refs = [
      {
        role,
        slot: 'active' as const,
        keyRef:
          policy.active?.keyRef ??
          buildSAMLSigningKeyRef({
            tenantId,
            role,
            policy,
          }),
      },
      ...nextRefs,
      policy.backup?.keyRef
        ? { role, slot: 'backup' as const, keyRef: policy.backup.keyRef }
        : null,
    ].filter(
      (ref): ref is { role: SAMLSigningRole; slot: 'active' | 'next' | 'backup'; keyRef: string } =>
        Boolean(ref)
    );

    for (const ref of refs) {
      assertSAMLKeyRefTenantBound(ref.keyRef, tenantId);
      if (seen.has(ref.keyRef)) {
        continue;
      }
      seen.add(ref.keyRef);
      const exported = await exportSigningKeyWithPrivateMaterial(env, tenantId, {
        keyRef: ref.keyRef,
        certificateSubject: settings.certificateSubject,
      });
      keys.push({
        role: ref.role,
        slot: ref.slot,
        ...exported,
      });
    }
  }
  return keys;
}

function validateRestoredSigningKeyPolicies(
  bundle: SAMLLocalSigningSecretDRBundle,
  tenantId: string
): void {
  const importedKeyRefs = new Set(bundle.keys.map((key) => key.keyRef));
  for (const role of ['idp', 'sp'] as const) {
    const policy = bundle.settings.signingKeyPolicies[role];
    for (const reference of [policy?.active, policy?.next, policy?.backup]) {
      if (!reference?.keyRef) {
        continue;
      }
      assertSAMLKeyRefTenantBound(reference.keyRef, tenantId);
      if (!importedKeyRefs.has(reference.keyRef)) {
        throw new Error('SAML DR bundle signing key policy references a missing key');
      }
    }
  }
}

function normalizeEncryptedSAMLLocalSigningDRBundle(
  input: unknown
): SAMLLocalSigningEncryptedDRBundle {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid encrypted SAML DR bundle');
  }
  const source = input as Record<string, unknown>;
  if (source.kind !== SAML_LOCAL_SIGNING_ENCRYPTED_DR_BUNDLE_KIND || source.version !== 1) {
    throw new Error('Unsupported encrypted SAML DR bundle');
  }
  const kdf =
    typeof source.kdf === 'object' && source.kdf !== null
      ? (source.kdf as Record<string, unknown>)
      : {};
  const cipher =
    typeof source.cipher === 'object' && source.cipher !== null
      ? (source.cipher as Record<string, unknown>)
      : {};
  const iterations =
    typeof kdf.iterations === 'number' && Number.isInteger(kdf.iterations) ? kdf.iterations : 0;
  if (
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    iterations < DR_BUNDLE_KDF_MIN_ITERATIONS ||
    iterations > DR_BUNDLE_KDF_MAX_ITERATIONS ||
    cipher.name !== 'AES-GCM'
  ) {
    throw new Error('Unsupported encrypted SAML DR bundle parameters');
  }

  return {
    kind: SAML_LOCAL_SIGNING_ENCRYPTED_DR_BUNDLE_KIND,
    version: 1,
    tenantId: readRequiredString(source.tenantId, 'tenantId', 128),
    generatedAt: readOptionalString(source.generatedAt, 64) || new Date(0).toISOString(),
    encrypted: true,
    sensitive: true,
    warning: readOptionalString(source.warning, 512),
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: readRequiredString(kdf.salt, 'kdf.salt', 128),
    },
    cipher: {
      name: 'AES-GCM',
      iv: readRequiredString(cipher.iv, 'cipher.iv', 128),
    },
    payload: readRequiredString(source.payload, 'payload', 1024 * 1024),
    payloadEncoding: 'base64',
  };
}

function normalizeSAMLLocalSigningSecretDRBundle(input: unknown): SAMLLocalSigningSecretDRBundle {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid SAML DR bundle');
  }
  const source = input as Record<string, unknown>;
  if (source.kind !== SAML_LOCAL_SIGNING_SECRET_DR_BUNDLE_KIND || source.version !== 1) {
    throw new Error('Unsupported SAML DR bundle');
  }
  const settings =
    typeof source.settings === 'object' && source.settings !== null
      ? (source.settings as Record<string, unknown>)
      : {};
  const entityIdStyle = normalizeSAMLEntityIdStyle(settings.entityIdStyle);
  const interactiveLoginUrlPolicy = normalizeSAMLInteractiveLoginUrlPolicy(
    settings.interactiveLoginUrlPolicy
  );
  if (!entityIdStyle || !interactiveLoginUrlPolicy) {
    throw new Error('Invalid SAML DR bundle settings');
  }
  const keys = Array.isArray(source.keys) ? source.keys.map(normalizeBundleKey) : [];
  if (keys.length === 0) {
    throw new Error('SAML DR bundle does not contain signing keys');
  }

  return {
    kind: SAML_LOCAL_SIGNING_SECRET_DR_BUNDLE_KIND,
    version: 1,
    tenantId: readRequiredString(source.tenantId, 'tenantId', 128),
    generatedAt: readOptionalString(source.generatedAt, 64) || new Date(0).toISOString(),
    sensitive: true,
    warning: readOptionalString(source.warning, 512),
    settings: {
      entityIdStyle,
      interactiveLoginUrlPolicy,
      certificateSubject: normalizeCertificateSubject(settings.certificateSubject),
      signingKeyPolicies: normalizeSigningKeyPolicies(settings.signingKeyPolicies),
    },
    generated: (typeof source.generated === 'object' && source.generated !== null
      ? source.generated
      : {}) as Awaited<ReturnType<typeof getSAMLLocalEntityIds>>,
    keys,
  };
}

function normalizeBundleKey(value: unknown): SAMLLocalSigningSecretDRKey {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid SAML DR bundle key');
  }
  const source = value as Record<string, unknown>;
  const role = source.role === 'idp' || source.role === 'sp' ? source.role : null;
  const slot =
    source.slot === 'active' || source.slot === 'next' || source.slot === 'backup'
      ? source.slot
      : null;
  if (!role || !slot) {
    throw new Error('Invalid SAML DR bundle key role or slot');
  }
  return {
    role,
    slot,
    keyRef: readRequiredString(source.keyRef, 'keyRef', 512),
    kid: readRequiredString(source.kid, 'kid', 256),
    publicJWK: normalizePublicJWK(source.publicJWK),
    privateKeyPem: readRequiredPem(source.privateKeyPem, 'PRIVATE KEY', 32 * 1024),
    certificate: readRequiredPem(source.certificate, 'CERTIFICATE', 16 * 1024),
    createdAt: readOptionalNumber(source.createdAt),
    certificateCreatedAt: readOptionalNumber(source.certificateCreatedAt),
    certificateSha256Thumbprint: readOptionalString(source.certificateSha256Thumbprint, 128),
  };
}

function normalizePublicJWK(value: unknown): JWK {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid SAML DR bundle public JWK');
  }
  const jwk = value as JWK;
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error('Invalid SAML DR bundle public JWK');
  }
  return jwk;
}

function normalizeCertificateSubject(value: unknown): Required<SAMLSigningCertificateSubject> {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    countryName: readOptionalString(source.countryName, 2).toUpperCase(),
    stateOrProvinceName: readOptionalString(source.stateOrProvinceName, 128),
    localityName: readOptionalString(source.localityName, 128),
    organizationName:
      readOptionalString(source.organizationName, 128) ||
      DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT.organizationName,
    organizationalUnitName: readOptionalString(source.organizationalUnitName, 128),
    commonName:
      readOptionalString(source.commonName, 128) ||
      DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT.commonName,
  };
}

function normalizeSigningKeyPolicies(value: unknown): {
  idp?: SAMLSigningKeyPolicy;
  sp?: SAMLSigningKeyPolicy;
} {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    idp:
      typeof source.idp === 'object' && source.idp
        ? (source.idp as SAMLSigningKeyPolicy)
        : undefined,
    sp:
      typeof source.sp === 'object' && source.sp ? (source.sp as SAMLSigningKeyPolicy) : undefined,
  };
}

function readRequiredString(value: unknown, field: string, maxLength: number): string {
  const normalized = readOptionalString(value, maxLength);
  if (!normalized) {
    throw new Error(`Missing SAML DR bundle field: ${field}`);
  }
  return normalized;
}

function readOptionalString(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, maxLength)
    : '';
}

function readRequiredPem(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    !value.startsWith(`-----BEGIN ${label}-----`) ||
    !value.includes(`-----END ${label}-----`)
  ) {
    throw new Error(`Invalid SAML DR bundle ${label.toLowerCase()} PEM`);
  }
  return value;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeDRBundlePassphrase(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('SAML DR bundle passphrase is required');
  }
  const passphrase = value;
  if (
    passphrase.length < DR_BUNDLE_PASSPHRASE_MIN_LENGTH ||
    passphrase.length > DR_BUNDLE_PASSPHRASE_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(passphrase)
  ) {
    throw new Error(
      `SAML DR bundle passphrase must be ${DR_BUNDLE_PASSPHRASE_MIN_LENGTH}-${DR_BUNDLE_PASSPHRASE_MAX_LENGTH} characters`
    );
  }
  return passphrase;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string, field: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw new Error(`Invalid encrypted SAML DR bundle ${field}`);
  }
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
