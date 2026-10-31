import { decryptValue, encryptValue } from '../../utils/pii-encryption.js';
import type { TenantBundleManifest } from './bundle-manifest.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { SqliteRestoreTarget } from './sqlite-restore-target.js';

const FIELD = 'secret_encrypted';
const MAX_SECRET_BYTES = 64 * 1024;

function invalid(): never {
  throw new Error('backup_portable_webhook_secret_invalid');
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

function required(row: PortableSqliteRow, column: string): string {
  const value = row[column];
  if (!value || value[0] !== 'text' || !value[1] || value[1].length > 512) invalid();
  return value[1];
}

function plaintext(value: string): string {
  if (!value || new TextEncoder().encode(value).length > MAX_SECRET_BYTES) invalid();
  return value;
}

export function portableWebhookSecret(row: PortableSqliteRow) {
  const tenantId = required(row, 'tenant_id');
  const webhookId = required(row, 'id');
  const value = row[FIELD];
  if (!value) invalid();
  if (value[0] === 'null' && value[1] === null) return { tenantId, webhookId, plaintext: null };
  if (value[0] !== 'text' || typeof value[1] !== 'string') invalid();
  try {
    const portable: unknown = JSON.parse(value[1]);
    if (
      !portable ||
      typeof portable !== 'object' ||
      Array.isArray(portable) ||
      Object.keys(portable).sort().join(',') !== 'kind,value,version' ||
      (portable as Record<string, unknown>).version !== 1 ||
      (portable as Record<string, unknown>).kind !== 'webhook_signing_secret' ||
      typeof (portable as Record<string, unknown>).value !== 'string'
    )
      invalid();
    return {
      tenantId,
      webhookId,
      plaintext: plaintext((portable as Record<string, string>).value),
    };
  } catch {
    return invalid();
  }
}

export async function exportPortableWebhookSecretRow(
  rowJson: string,
  sourceKey: string | undefined
): Promise<string> {
  const row = { ...parseRow(rowJson) } as Record<string, readonly [string, string | null]>;
  required(row, 'tenant_id');
  required(row, 'id');
  const value = row[FIELD];
  if (!value) invalid();
  if (value[0] === 'null' && value[1] === null) return rowJson;
  if (value[0] !== 'text' || !value[1] || !sourceKey) invalid();
  try {
    const decoded = await decryptValue(value[1], sourceKey);
    if (!decoded.wasEncrypted) invalid();
    row[FIELD] = [
      'text',
      JSON.stringify({
        version: 1,
        kind: 'webhook_signing_secret',
        value: plaintext(decoded.decrypted),
      }),
    ];
    return JSON.stringify(row);
  } catch {
    return invalid();
  }
}

async function matches(encrypted: string, key: string, expected: string): Promise<boolean> {
  try {
    const value = await decryptValue(encrypted, key);
    return value.wasEncrypted && value.decrypted === expected;
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
  const portable = portableWebhookSecret(parseRow(input.rowJson));
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
  const targetKey = input.targetKey;
  if (!targetKey || !Number.isSafeInteger(input.targetKeyVersion) || input.targetKeyVersion < 1)
    invalid();
  const expected = portable.plaintext;
  if (input.purpose === 'verify') {
    await input.target.verifySidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      FIELD,
      async (stored) => Boolean(stored && (await matches(stored, targetKey, expected)))
    );
    return;
  }
  const encrypted = (await encryptValue(expected, targetKey, 'AES-256-GCM', input.targetKeyVersion))
    .encrypted;
  await input.target.writeSidecarText(
    input.policy,
    input.manifest,
    input.rowJson,
    FIELD,
    encrypted,
    (stored) => matches(stored, targetKey, expected)
  );
}

export const restorePortableWebhookSecret = (input: Omit<Parameters<typeof apply>[0], 'purpose'>) =>
  apply({ ...input, purpose: 'restore' });

export const verifyPortableWebhookSecret = (input: Omit<Parameters<typeof apply>[0], 'purpose'>) =>
  apply({ ...input, purpose: 'verify' });
