import { decryptValue, encryptValue } from '../../utils/pii-encryption.js';
import type { TenantBundleManifest } from './bundle-manifest.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { SqliteRestoreTarget, SqliteSidecarValue } from './sqlite-restore-target.js';

const SECRET_FIELD = 'secret_encrypted';
const VERSION_FIELD = 'secret_key_version';
const MAX_SECRET_BYTES = 64 * 1024;

interface PortableTotpSecret {
  version: 1;
  kind: 'totp_secret';
  sourceKeyVersion: number;
  value: string;
}

function invalid(): never {
  throw new Error('backup_portable_totp_secret_invalid');
}

function parseRow(rowJson: string): PortableSqliteRow {
  try {
    const row: unknown = JSON.parse(rowJson);
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid();
    return row as PortableSqliteRow;
  } catch {
    return invalid();
  }
}

function requiredText(row: PortableSqliteRow, column: string, maxBytes = 512): string {
  const field = row[column];
  if (
    !field ||
    field[0] !== 'text' ||
    !field[1] ||
    new TextEncoder().encode(field[1]).length > maxBytes
  )
    invalid();
  return field[1];
}

function requiredVersion(row: PortableSqliteRow): number {
  const field = row[VERSION_FIELD];
  if (!field || field[0] !== 'integer' || !field[1] || !/^[1-9][0-9]{0,8}$/.test(field[1]))
    invalid();
  return Number(field[1]);
}

function checkedSecret(value: string): string {
  const bytes = new TextEncoder().encode(value).length;
  if (!bytes || bytes > MAX_SECRET_BYTES) invalid();
  return value;
}

export function portableTotpSecret(row: PortableSqliteRow): {
  tenantId: string;
  credentialId: string;
  plaintext: string;
  sourceKeyVersion: number;
} {
  const tenantId = requiredText(row, 'tenant_id');
  const credentialId = requiredText(row, 'id');
  const rowVersion = requiredVersion(row);
  let value: unknown;
  try {
    value = JSON.parse(requiredText(row, SECRET_FIELD, MAX_SECRET_BYTES + 1024));
  } catch {
    return invalid();
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'kind,sourceKeyVersion,value,version' ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).kind !== 'totp_secret' ||
    (value as Record<string, unknown>).sourceKeyVersion !== rowVersion ||
    typeof (value as Record<string, unknown>).value !== 'string'
  )
    invalid();
  return {
    tenantId,
    credentialId,
    plaintext: checkedSecret((value as PortableTotpSecret).value),
    sourceKeyVersion: rowVersion,
  };
}

/** Replace source-environment ciphertext before the row enters the encrypted bundle. */
export async function exportPortableTotpSecretRow(
  rowJson: string,
  sourceKey: string | undefined
): Promise<string> {
  const row = { ...parseRow(rowJson) } as Record<string, readonly [string, string | null]>;
  requiredText(row, 'tenant_id');
  requiredText(row, 'id');
  const sourceKeyVersion = requiredVersion(row);
  const ciphertext = requiredText(row, SECRET_FIELD, MAX_SECRET_BYTES + 1024);
  if (!sourceKey) invalid();
  try {
    const decrypted = await decryptValue(ciphertext, sourceKey);
    if (
      !decrypted.wasEncrypted ||
      decrypted.keyVersion !== sourceKeyVersion ||
      typeof decrypted.decrypted !== 'string'
    )
      invalid();
    const portable: PortableTotpSecret = {
      version: 1,
      kind: 'totp_secret',
      sourceKeyVersion,
      value: checkedSecret(decrypted.decrypted),
    };
    row[SECRET_FIELD] = ['text', JSON.stringify(portable)];
    return JSON.stringify(row);
  } catch {
    return invalid();
  }
}

async function ciphertextMatches(
  stored: string,
  targetKey: string,
  targetKeyVersion: number,
  plaintext: string
): Promise<boolean> {
  try {
    const decrypted = await decryptValue(stored, targetKey);
    return (
      decrypted.wasEncrypted &&
      decrypted.keyVersion === targetKeyVersion &&
      decrypted.decrypted === plaintext
    );
  } catch {
    return false;
  }
}

async function apply(input: {
  purpose: 'restore' | 'verify';
  target: SqliteRestoreTarget;
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  rowJson: string;
  targetKey: string | undefined;
  targetKeyVersion: number;
}): Promise<void> {
  const portable = portableTotpSecret(parseRow(input.rowJson));
  if (
    !input.targetKey ||
    !Number.isSafeInteger(input.targetKeyVersion) ||
    input.targetKeyVersion < 1
  )
    invalid();
  const key = input.targetKey;
  const version = input.targetKeyVersion;
  const secretMatches = (stored: string) =>
    ciphertextMatches(stored, key, version, portable.plaintext);
  const versionMatches = async (stored: SqliteSidecarValue) =>
    stored[0] === 'integer' && stored[1] === String(version);
  if (input.purpose === 'verify') {
    await input.target.verifySidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      SECRET_FIELD,
      async (stored) => stored !== null && secretMatches(stored)
    );
    await input.target.verifySidecarTypedValue(
      input.policy,
      input.manifest,
      input.rowJson,
      VERSION_FIELD,
      versionMatches
    );
    return;
  }
  const encrypted = await encryptValue(portable.plaintext, key, 'AES-256-GCM', version);
  await input.target.writeSidecarText(
    input.policy,
    input.manifest,
    input.rowJson,
    SECRET_FIELD,
    encrypted.encrypted,
    secretMatches
  );
  await input.target.writeSidecarValue(
    input.policy,
    input.manifest,
    input.rowJson,
    VERSION_FIELD,
    ['integer', String(version)],
    versionMatches
  );
}

export const restorePortableTotpSecret = (input: Omit<Parameters<typeof apply>[0], 'purpose'>) =>
  apply({ ...input, purpose: 'restore' });

export const verifyPortableTotpSecret = (input: Omit<Parameters<typeof apply>[0], 'purpose'>) =>
  apply({ ...input, purpose: 'verify' });
