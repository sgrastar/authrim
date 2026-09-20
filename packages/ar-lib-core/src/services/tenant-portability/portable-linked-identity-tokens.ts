import type { TenantBundleManifest } from './bundle-manifest.js';
import {
  decryptUpstreamProviderSecret,
  encryptUpstreamProviderSecret,
} from './portable-upstream-provider-secrets.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { SqliteRestoreTarget } from './sqlite-restore-target.js';

const FIELDS = ['access_token_encrypted', 'refresh_token_encrypted'] as const;
type Field = (typeof FIELDS)[number];
const MAX_TOKEN_BYTES = 256 * 1024;

interface PortableToken {
  version: 1;
  kind: 'linked_identity_token';
  field: Field;
  value: string;
}

function invalid(): never {
  throw new Error('backup_portable_linked_identity_token_invalid');
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
  const field = row[column];
  if (!field || field[0] !== 'text' || !field[1] || field[1].length > 512) invalid();
  return field[1];
}

function checked(value: string): string {
  const length = new TextEncoder().encode(value).length;
  if (!length || length > MAX_TOKEN_BYTES) invalid();
  return value;
}

function portableValue(row: PortableSqliteRow, field: Field): string | null {
  const value = row[field];
  if (value?.[0] === 'null' && value[1] === null) return null;
  if (!value || value[0] !== 'text' || !value[1]) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value[1]);
  } catch {
    return invalid();
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'field,kind,value,version' ||
    (parsed as Record<string, unknown>).version !== 1 ||
    (parsed as Record<string, unknown>).kind !== 'linked_identity_token' ||
    (parsed as Record<string, unknown>).field !== field ||
    typeof (parsed as Record<string, unknown>).value !== 'string'
  )
    invalid();
  return checked((parsed as PortableToken).value);
}

export function portableLinkedIdentityTokens(row: PortableSqliteRow) {
  return {
    tenantId: required(row, 'tenant_id'),
    identityId: required(row, 'id'),
    accessToken: portableValue(row, 'access_token_encrypted'),
    refreshToken: portableValue(row, 'refresh_token_encrypted'),
  };
}

/** Replace Bridge-compatible source ciphertext before bundle encryption. */
export async function exportPortableLinkedIdentityTokensRow(
  rowJson: string,
  sourceKey: string | undefined
): Promise<string> {
  const row = { ...parseRow(rowJson) } as Record<string, readonly [string, string | null]>;
  required(row, 'tenant_id');
  required(row, 'id');
  for (const field of FIELDS) {
    const value = row[field];
    if (value?.[0] === 'null' && value[1] === null) continue;
    if (!value || value[0] !== 'text' || !value[1] || !sourceKey) invalid();
    try {
      const portable: PortableToken = {
        version: 1,
        kind: 'linked_identity_token',
        field,
        value: checked(await decryptUpstreamProviderSecret(value[1], sourceKey)),
      };
      row[field] = ['text', JSON.stringify(portable)];
    } catch {
      return invalid();
    }
  }
  return JSON.stringify(row);
}

async function matches(stored: string, key: string, expected: string): Promise<boolean> {
  try {
    return (await decryptUpstreamProviderSecret(stored, key)) === expected;
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
}): Promise<void> {
  const portable = portableLinkedIdentityTokens(parseRow(input.rowJson));
  for (const [field, value] of [
    ['access_token_encrypted', portable.accessToken],
    ['refresh_token_encrypted', portable.refreshToken],
  ] as const) {
    if (value === null) {
      await input.target.verifySidecarValue(
        input.policy,
        input.manifest,
        input.rowJson,
        field,
        async (stored) => stored === null
      );
      continue;
    }
    if (!input.targetKey) invalid();
    const key = input.targetKey;
    if (input.purpose === 'restore') {
      await input.target.writeSidecarText(
        input.policy,
        input.manifest,
        input.rowJson,
        field,
        await encryptUpstreamProviderSecret(value, key),
        (stored) => matches(stored, key, value)
      );
    } else {
      await input.target.verifySidecarValue(
        input.policy,
        input.manifest,
        input.rowJson,
        field,
        async (stored) => stored !== null && matches(stored, key, value)
      );
    }
  }
}

export const restorePortableLinkedIdentityTokens = (
  input: Omit<Parameters<typeof apply>[0], 'purpose'>
) => apply({ ...input, purpose: 'restore' });

export const verifyPortableLinkedIdentityTokens = (
  input: Omit<Parameters<typeof apply>[0], 'purpose'>
) => apply({ ...input, purpose: 'verify' });
