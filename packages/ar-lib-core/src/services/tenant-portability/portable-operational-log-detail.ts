import { decryptValue, encryptValue } from '../../utils/pii-encryption.js';
import type { TenantBundleManifest } from './bundle-manifest.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { SqliteRestoreTarget, SqliteSidecarValue } from './sqlite-restore-target.js';

const DETAIL_FIELD = 'reason_detail_encrypted';
const VERSION_FIELD = 'encryption_key_version';
const MAX_DETAIL_BYTES = 256 * 1024;

interface PortableDetail {
  version: 1;
  kind: 'operational_log_detail';
  sourceKeyVersion: number;
  value: string;
}

function invalid(): never {
  throw new Error('backup_portable_operational_log_detail_invalid');
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

function text(row: PortableSqliteRow, column: string, nullable = false): string | null {
  const field = row[column];
  if (nullable && field?.[0] === 'null' && field[1] === null) return null;
  if (!field || field[0] !== 'text' || !field[1]) invalid();
  return field[1];
}

function integer(row: PortableSqliteRow, column: string): number {
  const field = row[column];
  if (
    !field ||
    field[0] !== 'integer' ||
    field[1] === null ||
    !/^(0|[1-9][0-9]{0,8})$/.test(field[1])
  )
    invalid();
  return Number(field[1]);
}

function checked(value: string): string {
  const length = new TextEncoder().encode(value).length;
  if (!length || length > MAX_DETAIL_BYTES) invalid();
  return value;
}

export function portableOperationalLogDetail(row: PortableSqliteRow):
  | { mode: 'external'; tenantId: string; logId: string; catalogId: string }
  | {
      mode: 'inline';
      tenantId: string;
      logId: string;
      plaintext: string;
      sourceKeyVersion: number;
    } {
  const tenantId = text(row, 'tenant_id') ?? invalid();
  const logId = text(row, 'id') ?? invalid();
  const keyVersion = integer(row, VERSION_FIELD);
  const detail = text(row, DETAIL_FIELD, true);
  const catalogId = text(row, 'detail_object_catalog_id', true);
  if (detail === null) {
    if (keyVersion !== 0 || !catalogId || catalogId.length > 512) invalid();
    return { mode: 'external', tenantId, logId, catalogId };
  }
  if (keyVersion < 1 || catalogId !== null) invalid();
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return invalid();
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'kind,sourceKeyVersion,value,version' ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).kind !== 'operational_log_detail' ||
    (value as Record<string, unknown>).sourceKeyVersion !== keyVersion ||
    typeof (value as Record<string, unknown>).value !== 'string'
  )
    invalid();
  return {
    mode: 'inline',
    tenantId,
    logId,
    plaintext: checked((value as PortableDetail).value),
    sourceKeyVersion: keyVersion,
  };
}

/** Convert inline source ciphertext; R2-backed rows retain only their catalog reference. */
export async function exportPortableOperationalLogDetailRow(
  rowJson: string,
  sourceKey: string | undefined
): Promise<string> {
  const row = { ...parseRow(rowJson) } as Record<string, readonly [string, string | null]>;
  text(row, 'tenant_id');
  text(row, 'id');
  const keyVersion = integer(row, VERSION_FIELD);
  const detail = text(row, DETAIL_FIELD, true);
  const catalogId = text(row, 'detail_object_catalog_id', true);
  if (detail === null) {
    if (keyVersion !== 0 || !catalogId) invalid();
    return rowJson;
  }
  if (!sourceKey || keyVersion < 1 || catalogId !== null) invalid();
  try {
    const decrypted = await decryptValue(detail, sourceKey);
    if (!decrypted.wasEncrypted || decrypted.keyVersion !== keyVersion) invalid();
    const portable: PortableDetail = {
      version: 1,
      kind: 'operational_log_detail',
      sourceKeyVersion: keyVersion,
      value: checked(decrypted.decrypted),
    };
    row[DETAIL_FIELD] = ['text', JSON.stringify(portable)];
    return JSON.stringify(row);
  } catch {
    return invalid();
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
  const portable = portableOperationalLogDetail(parseRow(input.rowJson));
  if (portable.mode === 'external') {
    await input.target.verifySidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      DETAIL_FIELD,
      async (stored) => stored === null
    );
    await input.target.verifySidecarTypedValue(
      input.policy,
      input.manifest,
      input.rowJson,
      VERSION_FIELD,
      async (stored) => stored[0] === 'integer' && stored[1] === '0'
    );
    return;
  }
  if (
    !input.targetKey ||
    !Number.isSafeInteger(input.targetKeyVersion) ||
    input.targetKeyVersion < 1
  )
    invalid();
  const key = input.targetKey;
  const version = input.targetKeyVersion;
  const detailMatches = async (stored: string | null) => {
    if (!stored) return false;
    try {
      const decrypted = await decryptValue(stored, key);
      return (
        decrypted.wasEncrypted &&
        decrypted.keyVersion === version &&
        decrypted.decrypted === portable.plaintext
      );
    } catch {
      return false;
    }
  };
  const versionMatches = async (stored: SqliteSidecarValue) =>
    stored[0] === 'integer' && stored[1] === String(version);
  if (input.purpose === 'restore') {
    const encrypted = await encryptValue(portable.plaintext, key, 'AES-256-GCM', version);
    await input.target.writeSidecarText(
      input.policy,
      input.manifest,
      input.rowJson,
      DETAIL_FIELD,
      encrypted.encrypted,
      async (stored) => detailMatches(stored)
    );
    await input.target.writeSidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      VERSION_FIELD,
      ['integer', String(version)],
      versionMatches
    );
    return;
  }
  await input.target.verifySidecarValue(
    input.policy,
    input.manifest,
    input.rowJson,
    DETAIL_FIELD,
    detailMatches
  );
  await input.target.verifySidecarTypedValue(
    input.policy,
    input.manifest,
    input.rowJson,
    VERSION_FIELD,
    versionMatches
  );
}

export const restorePortableOperationalLogDetail = (
  input: Omit<Parameters<typeof apply>[0], 'purpose'>
) => apply({ ...input, purpose: 'restore' });

export const verifyPortableOperationalLogDetail = (
  input: Omit<Parameters<typeof apply>[0], 'purpose'>
) => apply({ ...input, purpose: 'verify' });
