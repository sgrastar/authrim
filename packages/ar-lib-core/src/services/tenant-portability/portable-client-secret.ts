import { decryptValue, encryptValue } from '../../utils/pii-encryption.js';
import type { PortableSqliteRow } from './sqlite-dataset-inspector.js';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector.js';
import type { TenantBundleManifest } from './bundle-manifest.js';
import type { SqliteRestoreTarget } from './sqlite-restore-target.js';

const FIELD = 'logout_webhook_secret_encrypted';
const MAX_SECRET_BYTES = 64 * 1024;

interface PortableSecret {
  version: 1;
  kind: 'oauth_logout_webhook_secret';
  value: string;
}

function invalid(): never {
  throw new Error('backup_portable_client_secret_invalid');
}

function text(row: PortableSqliteRow, column: string): string {
  const field = row[column];
  if (
    !field ||
    field.length !== 2 ||
    field[0] !== 'text' ||
    typeof field[1] !== 'string' ||
    !field[1]
  )
    invalid();
  return field[1];
}

function checkedPlaintext(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (!bytes.length || bytes.length > MAX_SECRET_BYTES) invalid();
  return value;
}

function parseRow(rowJson: string): PortableSqliteRow {
  try {
    const value: unknown = JSON.parse(rowJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    return value as PortableSqliteRow;
  } catch {
    return invalid();
  }
}

/** Decode the bundle-only representation. The returned plaintext must never enter logs or cursors. */
export function portableOauthClientSecret(row: PortableSqliteRow): {
  tenantId: string;
  clientId: string;
  plaintext: string | null;
} {
  const tenantId = text(row, 'tenant_id');
  const clientId = text(row, 'client_id');
  const field = row[FIELD];
  if (!field || field.length !== 2) invalid();
  if (field[0] === 'null' && field[1] === null) return { tenantId, clientId, plaintext: null };
  if (field[0] !== 'text' || typeof field[1] !== 'string') invalid();
  try {
    const portable: unknown = JSON.parse(field[1]);
    if (
      !portable ||
      typeof portable !== 'object' ||
      Array.isArray(portable) ||
      Object.keys(portable).sort().join(',') !== 'kind,value,version' ||
      (portable as Record<string, unknown>).version !== 1 ||
      (portable as Record<string, unknown>).kind !== 'oauth_logout_webhook_secret' ||
      typeof (portable as Record<string, unknown>).value !== 'string'
    )
      invalid();
    return {
      tenantId,
      clientId,
      plaintext: checkedPlaintext((portable as PortableSecret).value),
    };
  } catch {
    return invalid();
  }
}

/** Replace source-at-rest ciphertext before the row enters the encrypted bundle stream. */
export async function exportPortableOauthClientSecretRow(
  rowJson: string,
  sourceEncryptionKey: string | undefined
): Promise<string> {
  const row = { ...parseRow(rowJson) } as Record<string, readonly [string, string | null]>;
  text(row, 'tenant_id');
  text(row, 'client_id');
  const field = row[FIELD];
  if (!field || field.length !== 2) invalid();
  if (field[0] === 'null' && field[1] === null) return rowJson;
  if (field[0] !== 'text' || typeof field[1] !== 'string' || !field[1]) invalid();
  if (!sourceEncryptionKey) invalid();
  try {
    const result = await decryptValue(field[1], sourceEncryptionKey);
    if (!result.wasEncrypted) invalid();
    const portable: PortableSecret = {
      version: 1,
      kind: 'oauth_logout_webhook_secret',
      value: checkedPlaintext(result.decrypted),
    };
    row[FIELD] = ['text', JSON.stringify(portable)];
    return JSON.stringify(row);
  } catch {
    return invalid();
  }
}

/** Encrypt one validated bundle secret for the target environment. */
export async function encryptPortableOauthClientSecret(
  plaintext: string,
  targetEncryptionKey: string,
  targetKeyVersion: number
): Promise<string> {
  if (!Number.isSafeInteger(targetKeyVersion) || targetKeyVersion < 1) invalid();
  try {
    return (
      await encryptValue(
        checkedPlaintext(plaintext),
        targetEncryptionKey,
        'AES-256-GCM',
        targetKeyVersion
      )
    ).encrypted;
  } catch {
    return invalid();
  }
}

/** Lost-response retry check for a value already encrypted with the target key. */
export async function targetOauthClientSecretMatches(
  encrypted: string,
  targetEncryptionKey: string,
  plaintext: string
): Promise<boolean> {
  try {
    const result = await decryptValue(encrypted, targetEncryptionKey);
    return result.wasEncrypted && result.decrypted === checkedPlaintext(plaintext);
  } catch {
    return false;
  }
}

/** Apply one validated portable row to an unpublished target with lost-response retry safety. */
export async function restorePortableOauthClientSecret(input: {
  target: SqliteRestoreTarget;
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  rowJson: string;
  targetEncryptionKey: string | undefined;
  targetKeyVersion: number;
}): Promise<void> {
  const portable = portableOauthClientSecret(parseRow(input.rowJson));
  if (portable.plaintext === null) {
    await input.target.verifySidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      FIELD,
      async (stored) => stored === null
    );
    return;
  }
  const plaintext = portable.plaintext;
  const targetEncryptionKey = input.targetEncryptionKey;
  if (!targetEncryptionKey) invalid();
  const encrypted = await encryptPortableOauthClientSecret(
    plaintext,
    targetEncryptionKey,
    input.targetKeyVersion
  );
  await input.target.writeSidecarText(
    input.policy,
    input.manifest,
    input.rowJson,
    FIELD,
    encrypted,
    (stored) => targetOauthClientSecretMatches(stored, targetEncryptionKey, plaintext)
  );
}

/** Read back one sealed target row and compare it to the validated portable plaintext. */
export async function verifyPortableOauthClientSecret(input: {
  target: SqliteRestoreTarget;
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  rowJson: string;
  targetEncryptionKey: string | undefined;
}): Promise<void> {
  const portable = portableOauthClientSecret(parseRow(input.rowJson));
  if (portable.plaintext === null) {
    await input.target.verifySidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      FIELD,
      async (stored) => stored === null
    );
    return;
  }
  const targetEncryptionKey = input.targetEncryptionKey;
  if (!targetEncryptionKey) invalid();
  const plaintext = portable.plaintext;
  await input.target.verifySidecarValue(
    input.policy,
    input.manifest,
    input.rowJson,
    FIELD,
    async (stored) =>
      stored !== null && targetOauthClientSecretMatches(stored, targetEncryptionKey, plaintext)
  );
}
