import type { Env } from '@authrim/ar-lib-core';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  unwrapLoggingKeyMaterial,
  wrapLoggingKeyMaterial,
  type EncryptedCredentialSecretEnvelope,
  type WrappedLoggingKeyMaterialEnvelope,
} from '@authrim/ar-lib-logging/keys';
import type { Phase3OtherStoreSource } from './tenant-backup-phase3-other-stores';

type DatasetId = 'admin.credential_secret_bodies' | 'admin.logging_key_material_bodies';

type TypedValue = readonly ['null', null] | readonly ['text' | 'integer', string];

interface PortableCredentialSecret {
  version: 1;
  kind: 'credential_secret';
  contentType: string;
  plaintextBase64Url: string;
}

interface PortableLoggingKeyMaterial {
  version: 1;
  kind: 'logging_key_material';
  algorithm: 'AES-GCM';
  keyBytesBase64Url: string;
}

type PortableAdminEnvelope = PortableCredentialSecret | PortableLoggingKeyMaterial;

const MAX_PORTABLE_BYTES = 64 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function invalid(): never {
  throw new Error('backup_admin_envelope_invalid');
}

function rootKey(env: Pick<Env, 'OBJECT_ENCRYPTION_ROOT_KEY'>): string {
  const value = env.OBJECT_ENCRYPTION_ROOT_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/u.test(value)) invalid();
  return value;
}

function keyVersion(env: Pick<Env, 'OBJECT_ENCRYPTION_KEY_VERSION'>): number {
  const value = env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,8}$/u.test(value)) invalid();
  return Number(value);
}

function row(value: string): PortableSqliteRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  return parsed as PortableSqliteRow;
}

function typed(rowValue: PortableSqliteRow, column: string, type: 'text' | 'integer'): string {
  const value = rowValue[column] as TypedValue | undefined;
  if (!value || value[0] !== type || typeof value[1] !== 'string' || !value[1]) invalid();
  return value[1];
}

function positiveInteger(rowValue: PortableSqliteRow, column: string): number {
  const value = typed(rowValue, column, 'integer');
  if (!/^[1-9][0-9]{0,8}$/u.test(value)) invalid();
  return Number(value);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!value || value.length > MAX_PORTABLE_BYTES * 2 || !BASE64URL.test(value)) invalid();
  try {
    const padded = value
      .replace(/-/gu, '+')
      .replace(/_/gu, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (!bytes.length || bytes.length > MAX_PORTABLE_BYTES || toBase64Url(bytes) !== value)
      invalid();
    return bytes;
  } catch {
    return invalid();
  }
}

function portableEnvelope(value: string, datasetId: DatasetId): PortableAdminEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const record = parsed as Record<string, unknown>;
  if (datasetId === 'admin.credential_secret_bodies') {
    if (
      Object.keys(record).sort().join(',') !== 'contentType,kind,plaintextBase64Url,version' ||
      record.version !== 1 ||
      record.kind !== 'credential_secret' ||
      typeof record.contentType !== 'string' ||
      !record.contentType ||
      record.contentType.length > 256 ||
      typeof record.plaintextBase64Url !== 'string'
    )
      invalid();
    fromBase64Url(record.plaintextBase64Url);
    return record as unknown as PortableCredentialSecret;
  }
  if (
    Object.keys(record).sort().join(',') !== 'algorithm,keyBytesBase64Url,kind,version' ||
    record.version !== 1 ||
    record.kind !== 'logging_key_material' ||
    record.algorithm !== 'AES-GCM' ||
    typeof record.keyBytesBase64Url !== 'string'
  )
    invalid();
  const bytes = fromBase64Url(record.keyBytesBase64Url);
  if (bytes.length !== 32) invalid();
  return record as unknown as PortableLoggingKeyMaterial;
}

function replaceEnvelope(rowJson: string, envelope: PortableAdminEnvelope): string {
  const parsed = row(rowJson) as Record<string, TypedValue>;
  typed(parsed, 'envelope_json', 'text');
  parsed.envelope_json = ['text', JSON.stringify(envelope)];
  return JSON.stringify(parsed);
}

function credentialIdentity(rowValue: PortableSqliteRow) {
  return {
    credentialRef: typed(rowValue, 'credential_ref', 'text'),
    destinationId: typed(rowValue, 'destination_id', 'text'),
    version: positiveInteger(rowValue, 'version'),
  };
}

function loggingIdentity(rowValue: PortableSqliteRow) {
  return {
    backendRef: typed(rowValue, 'backend_ref', 'text'),
    scopeId: typed(rowValue, 'scope_id', 'text'),
    version: positiveInteger(rowValue, 'version'),
  };
}

async function transform(
  env: Pick<Env, 'OBJECT_ENCRYPTION_ROOT_KEY'>,
  datasetId: DatasetId,
  rowJson: string
): Promise<string> {
  const parsed = row(rowJson);
  const serializedEnvelope = typed(parsed, 'envelope_json', 'text');
  if (datasetId === 'admin.credential_secret_bodies') {
    let envelope: EncryptedCredentialSecretEnvelope;
    try {
      envelope = JSON.parse(serializedEnvelope) as EncryptedCredentialSecretEnvelope;
    } catch {
      return invalid();
    }
    const identity = credentialIdentity(parsed);
    const plaintext = await decryptCredentialSecret(envelope, {
      rootKeyHex: rootKey(env),
      ...identity,
    }).catch(invalid);
    return replaceEnvelope(rowJson, {
      version: 1,
      kind: 'credential_secret',
      contentType: envelope.contentType,
      plaintextBase64Url: toBase64Url(new TextEncoder().encode(plaintext)),
    });
  }
  let envelope: WrappedLoggingKeyMaterialEnvelope;
  try {
    envelope = JSON.parse(serializedEnvelope) as WrappedLoggingKeyMaterialEnvelope;
  } catch {
    return invalid();
  }
  const material = await unwrapLoggingKeyMaterial(envelope, {
    rootKeyHex: rootKey(env),
    ...loggingIdentity(parsed),
  }).catch(invalid);
  try {
    return replaceEnvelope(rowJson, {
      version: 1,
      kind: 'logging_key_material',
      algorithm: material.algorithm,
      keyBytesBase64Url: toBase64Url(material.keyBytes),
    });
  } finally {
    material.keyBytes.fill(0);
  }
}

function validate(datasetId: string, rowValue: PortableSqliteRow): void {
  if (
    datasetId !== 'admin.credential_secret_bodies' &&
    datasetId !== 'admin.logging_key_material_bodies'
  )
    invalid();
  portableEnvelope(typed(rowValue, 'envelope_json', 'text'), datasetId);
  if (datasetId === 'admin.credential_secret_bodies') credentialIdentity(rowValue);
  else loggingIdentity(rowValue);
}

async function targetEnvelope(
  env: Pick<Env, 'OBJECT_ENCRYPTION_ROOT_KEY' | 'OBJECT_ENCRYPTION_KEY_VERSION'>,
  datasetId: DatasetId,
  rowJson: string
): Promise<{ value: string; matches(value: string | null): Promise<boolean> }> {
  const parsed = row(rowJson);
  const portable = portableEnvelope(typed(parsed, 'envelope_json', 'text'), datasetId);
  if (portable.kind === 'credential_secret') {
    const identity = credentialIdentity(parsed);
    const plaintext = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      fromBase64Url(portable.plaintextBase64Url)
    );
    const envelope = await encryptCredentialSecret(plaintext, {
      rootKeyHex: rootKey(env),
      backend: 'd1_encrypted_table',
      keyVersion: keyVersion(env),
      contentType: portable.contentType,
      ...identity,
    });
    return {
      value: JSON.stringify(envelope),
      async matches(value) {
        if (value === null) return false;
        try {
          const candidate = JSON.parse(value) as EncryptedCredentialSecretEnvelope;
          return (
            candidate.contentType === portable.contentType &&
            (await decryptCredentialSecret(candidate, {
              rootKeyHex: rootKey(env),
              ...identity,
            })) === plaintext
          );
        } catch {
          return false;
        }
      },
    };
  }
  const identity = loggingIdentity(parsed);
  const keyBytes = fromBase64Url(portable.keyBytesBase64Url);
  try {
    const envelope = await wrapLoggingKeyMaterial(
      { algorithm: portable.algorithm, keyBytes },
      {
        rootKeyHex: rootKey(env),
        backend: 'd1_wrapped_key',
        keyVersion: keyVersion(env),
        ...identity,
      }
    );
    return {
      value: JSON.stringify(envelope),
      async matches(value) {
        if (value === null) return false;
        let unwrapped: Awaited<ReturnType<typeof unwrapLoggingKeyMaterial>> | undefined;
        try {
          const candidate: unknown = JSON.parse(value);
          unwrapped = await unwrapLoggingKeyMaterial(
            candidate as WrappedLoggingKeyMaterialEnvelope,
            {
              rootKeyHex: rootKey(env),
              ...identity,
            }
          );
          return (
            unwrapped.algorithm === portable.algorithm &&
            toBase64Url(unwrapped.keyBytes) === portable.keyBytesBase64Url
          );
        } catch {
          return false;
        } finally {
          unwrapped?.keyBytes.fill(0);
        }
      },
    };
  } finally {
    keyBytes.fill(0);
  }
}

/** Rewrap Admin D1 secret envelopes through the encrypted tenant bundle. */
export function createTenantBackupAdminEnvelopePorts(
  env: Pick<Env, 'OBJECT_ENCRYPTION_ROOT_KEY' | 'OBJECT_ENCRYPTION_KEY_VERSION'>
) {
  return {
    transformAdminEnvelope: (datasetId: string, rowJson: string) => {
      if (
        datasetId !== 'admin.credential_secret_bodies' &&
        datasetId !== 'admin.logging_key_material_bodies'
      )
        return Promise.reject(new Error('backup_admin_envelope_invalid'));
      return transform(env, datasetId, rowJson);
    },
    async validateAdminEnvelope(datasetId: string, rowValue: PortableSqliteRow): Promise<void> {
      validate(datasetId, rowValue);
    },
    async restoreAdminEnvelope(
      _context: unknown,
      datasetId: DatasetId,
      source: Phase3OtherStoreSource,
      rowJson: string
    ): Promise<void> {
      const target = await targetEnvelope(env, datasetId, rowJson);
      await source.target.writeSidecarText(
        source.policy,
        source.manifest,
        rowJson,
        'envelope_json',
        target.value,
        (value) => target.matches(value)
      );
    },
    async verifyAdminEnvelope(
      _context: unknown,
      datasetId: DatasetId,
      source: Phase3OtherStoreSource,
      rowJson: string
    ): Promise<boolean> {
      const target = await targetEnvelope(env, datasetId, rowJson);
      await source.target.verifySidecarValue(
        source.policy,
        source.manifest,
        rowJson,
        'envelope_json',
        (value) => target.matches(value)
      );
      return true;
    },
  };
}
