import { calculateJwkThumbprint, type JWK } from 'jose';
import type { TenantBundleManifest } from './bundle-manifest.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { SqliteRestoreTarget } from './sqlite-restore-target.js';

const CLIENT_FIELD = 'client_secret_encrypted';
const PRIVATE_JWK_FIELD = 'private_key_jwk_encrypted';
const PUBLIC_JWK_FIELD = 'public_key_jwk';
const MAX_SECRET_BYTES = 128 * 1024;

type PortableField = 'client_secret' | 'request_object_private_jwk';
interface PortableSecret {
  version: 1;
  kind: 'upstream_provider_secret';
  field: PortableField;
  value: string | null;
}

function invalid(): never {
  throw new Error('backup_portable_upstream_provider_secret_invalid');
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
  if (!field || field.length !== 2) invalid();
  if (nullable && field[0] === 'null' && field[1] === null) return null;
  if (field[0] !== 'text' || typeof field[1] !== 'string') invalid();
  return field[1];
}

function checkedPlaintext(value: string): string {
  const length = new TextEncoder().encode(value).length;
  if (!length || length > MAX_SECRET_BYTES) invalid();
  return value;
}

function parsePortable(value: string, expected: PortableField): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'field,kind,value,version' ||
      (parsed as Record<string, unknown>).version !== 1 ||
      (parsed as Record<string, unknown>).kind !== 'upstream_provider_secret' ||
      (parsed as Record<string, unknown>).field !== expected ||
      ((parsed as Record<string, unknown>).value !== null &&
        typeof (parsed as Record<string, unknown>).value !== 'string')
    )
      invalid();
    const plaintext = (parsed as PortableSecret).value;
    return plaintext === null ? null : checkedPlaintext(plaintext);
  } catch {
    return invalid();
  }
}

function portable(field: PortableField, value: string | null): readonly ['text', string] {
  const result: PortableSecret = { version: 1, kind: 'upstream_provider_secret', field, value };
  return ['text', JSON.stringify(result)];
}

function keyBytes(hexKey: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) invalid();
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1)
    result[index] = Number.parseInt(hexKey.slice(index * 2, index * 2 + 2), 16);
  return result;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function unbase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return invalid();
  }
}

async function encryptionKey(hexKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes(hexKey), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptUpstreamProviderSecret(
  plaintext: string,
  hexKey: string
): Promise<string> {
  const value = new TextEncoder().encode(checkedPlaintext(plaintext));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        await encryptionKey(hexKey),
        value
      )
    );
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv);
    combined.set(encrypted, iv.length);
    return base64(combined);
  } catch {
    return invalid();
  }
}

export async function decryptUpstreamProviderSecret(
  encrypted: string,
  hexKey: string
): Promise<string> {
  const combined = unbase64(encrypted);
  if (combined.length < 29) invalid();
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: combined.slice(0, 12), tagLength: 128 },
      await encryptionKey(hexKey),
      combined.slice(12)
    );
    return checkedPlaintext(new TextDecoder().decode(plaintext));
  } catch {
    return invalid();
  }
}

async function assertPrivateJwkMatchesPublic(
  privateJwkJson: string | null,
  publicJwkJson: string | null
): Promise<void> {
  if (privateJwkJson === null) return;
  if (publicJwkJson === null) invalid();
  try {
    const privateJwk: unknown = JSON.parse(privateJwkJson);
    const publicJwk: unknown = JSON.parse(publicJwkJson);
    if (
      !privateJwk ||
      typeof privateJwk !== 'object' ||
      Array.isArray(privateJwk) ||
      typeof (privateJwk as Record<string, unknown>).d !== 'string' ||
      !publicJwk ||
      typeof publicJwk !== 'object' ||
      Array.isArray(publicJwk) ||
      (publicJwk as Record<string, unknown>).d !== undefined ||
      (await calculateJwkThumbprint(privateJwk as JWK)) !==
        (await calculateJwkThumbprint(publicJwk as JWK))
    )
      invalid();
  } catch {
    return invalid();
  }
}

/** Decode and validate the bundle-only plaintext representation. */
export async function portableUpstreamProviderSecrets(row: PortableSqliteRow): Promise<{
  tenantId: string;
  providerId: string;
  clientSecret: string | null;
  privateJwk: string | null;
}> {
  const tenantId = text(row, 'tenant_id');
  const providerId = text(row, 'id');
  if (!tenantId || !providerId) invalid();
  const clientSecret = parsePortable(text(row, CLIENT_FIELD) ?? '', 'client_secret');
  const privateJwk = parsePortable(
    text(row, PRIVATE_JWK_FIELD) ?? '',
    'request_object_private_jwk'
  );
  await assertPrivateJwkMatchesPublic(privateJwk, text(row, PUBLIC_JWK_FIELD, true));
  return { tenantId, providerId, clientSecret, privateJwk };
}

/** Replace source-at-rest ciphertext before the row enters the encrypted tenant bundle. */
export async function exportPortableUpstreamProviderSecretsRow(
  rowJson: string,
  sourceEncryptionKey: string | undefined
): Promise<string> {
  const row = { ...parseRow(rowJson) } as Record<string, readonly [string, string | null]>;
  if (!text(row, 'tenant_id') || !text(row, 'id')) invalid();
  const clientCiphertext = text(row, CLIENT_FIELD);
  const privateCiphertext = text(row, PRIVATE_JWK_FIELD, true);
  if ((clientCiphertext || privateCiphertext) && !sourceEncryptionKey) invalid();
  const clientSecret = clientCiphertext
    ? await decryptUpstreamProviderSecret(clientCiphertext, sourceEncryptionKey as string)
    : null;
  const privateJwk = privateCiphertext
    ? await decryptUpstreamProviderSecret(privateCiphertext, sourceEncryptionKey as string)
    : null;
  await assertPrivateJwkMatchesPublic(privateJwk, text(row, PUBLIC_JWK_FIELD, true));
  row[CLIENT_FIELD] = portable('client_secret', clientSecret);
  row[PRIVATE_JWK_FIELD] = portable('request_object_private_jwk', privateJwk);
  return JSON.stringify(row);
}

async function encryptedMatches(
  encrypted: string,
  targetEncryptionKey: string,
  plaintext: string
): Promise<boolean> {
  try {
    return (await decryptUpstreamProviderSecret(encrypted, targetEncryptionKey)) === plaintext;
  } catch {
    return false;
  }
}

async function restoreField(input: {
  target: SqliteRestoreTarget;
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  rowJson: string;
  field: string;
  plaintext: string | null;
  emptyValue: string | null;
  targetEncryptionKey: string | undefined;
}) {
  if (input.plaintext === null) {
    await input.target.verifySidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      input.field,
      async (stored) => stored === input.emptyValue
    );
    return;
  }
  if (!input.targetEncryptionKey) invalid();
  const plaintext = input.plaintext;
  const key = input.targetEncryptionKey;
  await input.target.writeSidecarText(
    input.policy,
    input.manifest,
    input.rowJson,
    input.field,
    await encryptUpstreamProviderSecret(plaintext, key),
    (stored) => encryptedMatches(stored, key, plaintext)
  );
}

/** Restore both upstream provider secrets under the target environment key. */
export async function restorePortableUpstreamProviderSecrets(input: {
  target: SqliteRestoreTarget;
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  rowJson: string;
  targetEncryptionKey: string | undefined;
}): Promise<void> {
  const secrets = await portableUpstreamProviderSecrets(parseRow(input.rowJson));
  await restoreField({
    ...input,
    field: CLIENT_FIELD,
    plaintext: secrets.clientSecret,
    emptyValue: '',
  });
  await restoreField({
    ...input,
    field: PRIVATE_JWK_FIELD,
    plaintext: secrets.privateJwk,
    emptyValue: null,
  });
}

/** Verify target ciphertext without exposing plaintext outside this function. */
export async function verifyPortableUpstreamProviderSecrets(input: {
  target: SqliteRestoreTarget;
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  rowJson: string;
  targetEncryptionKey: string | undefined;
}): Promise<void> {
  const secrets = await portableUpstreamProviderSecrets(parseRow(input.rowJson));
  for (const [field, plaintext, emptyValue] of [
    [CLIENT_FIELD, secrets.clientSecret, ''],
    [PRIVATE_JWK_FIELD, secrets.privateJwk, null],
  ] as const) {
    await input.target.verifySidecarValue(
      input.policy,
      input.manifest,
      input.rowJson,
      field,
      async (stored) =>
        plaintext === null
          ? stored === emptyValue
          : Boolean(
              input.targetEncryptionKey &&
              stored &&
              (await encryptedMatches(stored, input.targetEncryptionKey, plaintext))
            )
    );
  }
}
