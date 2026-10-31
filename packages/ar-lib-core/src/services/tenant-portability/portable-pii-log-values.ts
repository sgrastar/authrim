import {
  arrayBufferToBase64,
  decryptPIIValues,
  generateAAD,
  type EncryptedValueForDecrypt,
} from '../audit/utils.js';
import type { TenantBundleManifest } from './bundle-manifest.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { SqliteRestoreTarget, SqliteSidecarValue } from './sqlite-restore-target.js';

const VALUES_FIELD = 'values_encrypted';
const KEY_ID_FIELD = 'encryption_key_id';
const IV_FIELD = 'encryption_iv';
const MAX_PLAINTEXT_BYTES = 256 * 1024;

interface PortableValues {
  version: 1;
  kind: 'pii_log_values';
  sourceKeyId: string;
  value: string;
}

export type PortablePiiLogValues =
  | {
      mode: 'external';
      tenantId: string;
      logId: string;
      affectedFields: string[];
      catalogReference: string;
    }
  | {
      mode: 'inline';
      tenantId: string;
      logId: string;
      affectedFields: string[];
      sourceKeyId: string;
      plaintext: string;
    };

function invalid(): never {
  throw new Error('backup_portable_pii_log_values_invalid');
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
  const value = row[column];
  if (nullable && value?.[0] === 'null' && value[1] === null) return null;
  if (!value || value[0] !== 'text' || value[1] === null || !value[1]) invalid();
  return value[1];
}

function affectedFields(row: PortableSqliteRow): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(row, 'affected_fields') ?? invalid());
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 256 ||
    parsed.some((field) => typeof field !== 'string' || !field || field.length > 256) ||
    new Set(parsed).size !== parsed.length
  )
    invalid();
  return parsed as string[];
}

function checkedPlaintext(value: string): string {
  if (!value || new TextEncoder().encode(value).length > MAX_PLAINTEXT_BYTES) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  return value;
}

function bytesFromHex(value: string | undefined): Uint8Array {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) invalid();
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

async function keyFromHex(value: string | undefined): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytesFromHex(value), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function targetIv(
  portable: Extract<PortablePiiLogValues, { mode: 'inline' }>,
  keyHex: string,
  keyVersion: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    bytesFromHex(keyHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const value = JSON.stringify([
    'authrim-tenant-backup-pii-log-iv-v1',
    portable.tenantId,
    portable.logId,
    portable.affectedFields,
    portable.plaintext,
    keyVersion,
  ]);
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  ).slice(0, 12);
}

export function portablePiiLogValues(row: PortableSqliteRow): PortablePiiLogValues {
  const tenantId = text(row, 'tenant_id') ?? invalid();
  const logId = text(row, 'id') ?? invalid();
  const fields = affectedFields(row);
  const values = text(row, VALUES_FIELD, true);
  const catalogReference = text(row, 'values_r2_key', true);
  const sourceKeyId = text(row, KEY_ID_FIELD) ?? invalid();
  text(row, IV_FIELD);
  if ((values === null) === (catalogReference === null)) invalid();
  if (catalogReference !== null) {
    if (!catalogReference.startsWith('sensitive-detail-catalog:')) invalid();
    return {
      mode: 'external',
      tenantId,
      logId,
      affectedFields: fields,
      catalogReference,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(values ?? invalid());
  } catch {
    return invalid();
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'kind,sourceKeyId,value,version' ||
    (parsed as Record<string, unknown>).version !== 1 ||
    (parsed as Record<string, unknown>).kind !== 'pii_log_values' ||
    (parsed as Record<string, unknown>).sourceKeyId !== sourceKeyId ||
    typeof (parsed as Record<string, unknown>).value !== 'string'
  )
    invalid();
  return {
    mode: 'inline',
    tenantId,
    logId,
    affectedFields: fields,
    sourceKeyId,
    plaintext: checkedPlaintext((parsed as PortableValues).value),
  };
}

/** Convert inline audit ciphertext to a bundle-only portable payload. */
export async function exportPortablePiiLogValuesRow(
  rowJson: string,
  sourceKey: string | undefined,
  loadExternal?: (catalogReference: string) => Promise<string | null>
): Promise<string> {
  const row = { ...parseRow(rowJson) } as Record<string, readonly [string, string | null]>;
  const tenantId = text(row, 'tenant_id') ?? invalid();
  text(row, 'id');
  const fields = affectedFields(row);
  const values = text(row, VALUES_FIELD, true);
  const catalogReference = text(row, 'values_r2_key', true);
  const keyId = text(row, KEY_ID_FIELD) ?? invalid();
  const iv = text(row, IV_FIELD) ?? invalid();
  if ((values === null) === (catalogReference === null)) invalid();
  let encryptedJson = values;
  if (encryptedJson === null) {
    if (!catalogReference?.startsWith('sensitive-detail-catalog:') || !loadExternal) invalid();
    encryptedJson = await loadExternal(catalogReference);
    if (!encryptedJson) invalid();
  }
  let encrypted: EncryptedValueForDecrypt;
  try {
    encrypted = JSON.parse(encryptedJson) as EncryptedValueForDecrypt;
  } catch {
    return invalid();
  }
  if (
    !encrypted ||
    typeof encrypted !== 'object' ||
    encrypted.keyId !== keyId ||
    encrypted.iv !== iv ||
    typeof encrypted.ciphertext !== 'string' ||
    !encrypted.ciphertext
  )
    invalid();
  try {
    const key = await keyFromHex(sourceKey);
    const plaintext = checkedPlaintext(
      JSON.stringify(
        await decryptPIIValues(encrypted, tenantId, fields, async (requestedKeyId) => {
          if (requestedKeyId !== keyId) invalid();
          return key;
        })
      )
    );
    row[VALUES_FIELD] = [
      'text',
      JSON.stringify({
        version: 1,
        kind: 'pii_log_values',
        sourceKeyId: keyId,
        value: plaintext,
      } satisfies PortableValues),
    ];
    row.values_r2_key = ['null', null];
    return JSON.stringify(row);
  } catch {
    return invalid();
  }
}

async function encryptTarget(
  portable: Extract<PortablePiiLogValues, { mode: 'inline' }>,
  keyHex: string,
  keyVersion: number
): Promise<EncryptedValueForDecrypt> {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) invalid();
  const key = await keyFromHex(keyHex);
  const iv = await targetIv(portable, keyHex, keyVersion);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: generateAAD(portable.tenantId, portable.affectedFields),
    },
    key,
    new TextEncoder().encode(portable.plaintext)
  );
  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    keyId: `pii-key-v${keyVersion}`,
  };
}

async function matches(
  stored: string | null,
  portable: Extract<PortablePiiLogValues, { mode: 'inline' }>,
  targetKey: string,
  targetKeyVersion: number
): Promise<boolean> {
  if (!stored) return false;
  try {
    const encrypted = JSON.parse(stored) as EncryptedValueForDecrypt;
    if (encrypted.keyId !== `pii-key-v${targetKeyVersion}`) return false;
    const key = await keyFromHex(targetKey);
    const decrypted = await decryptPIIValues(
      encrypted,
      portable.tenantId,
      portable.affectedFields,
      async () => key
    );
    return JSON.stringify(decrypted) === portable.plaintext;
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
}): Promise<'external' | 'inline'> {
  const portable = portablePiiLogValues(parseRow(input.rowJson));
  if (portable.mode === 'external') return 'external';
  if (!input.targetKey) invalid();
  const targetKey = input.targetKey;
  const targetKeyId = `pii-key-v${input.targetKeyVersion}`;
  const expectedIv = arrayBufferToBase64(
    (await targetIv(portable, targetKey, input.targetKeyVersion)).buffer as ArrayBuffer
  );
  const valueMatches = (stored: string | null) =>
    matches(stored, portable, targetKey, input.targetKeyVersion);
  const keyIdMatches = async (stored: SqliteSidecarValue) =>
    stored[0] === 'text' && stored[1] === targetKeyId;
  if (input.purpose === 'restore') {
    const encrypted = await encryptTarget(portable, targetKey, input.targetKeyVersion);
    await input.target.writeSidecarText(
      input.policy,
      input.manifest,
      input.rowJson,
      VALUES_FIELD,
      JSON.stringify(encrypted),
      valueMatches
    );
    await input.target.writeSidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      KEY_ID_FIELD,
      ['text', encrypted.keyId],
      keyIdMatches
    );
    await input.target.writeSidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      IV_FIELD,
      ['text', expectedIv],
      async (stored) => stored[0] === 'text' && stored[1] === expectedIv
    );
    return 'inline';
  }
  await input.target.verifySidecarValue(
    input.policy,
    input.manifest,
    input.rowJson,
    VALUES_FIELD,
    valueMatches
  );
  await input.target.verifySidecarTypedValue(
    input.policy,
    input.manifest,
    input.rowJson,
    KEY_ID_FIELD,
    keyIdMatches
  );
  await input.target.verifySidecarTypedValue(
    input.policy,
    input.manifest,
    input.rowJson,
    IV_FIELD,
    async (stored) => stored[0] === 'text' && stored[1] === expectedIv
  );
  return 'inline';
}

export const restorePortablePiiLogValues = (input: Omit<Parameters<typeof apply>[0], 'purpose'>) =>
  apply({ ...input, purpose: 'restore' });

export const verifyPortablePiiLogValues = (input: Omit<Parameters<typeof apply>[0], 'purpose'>) =>
  apply({ ...input, purpose: 'verify' });
