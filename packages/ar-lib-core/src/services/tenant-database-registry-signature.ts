import type { TenantDatabaseRegistryRow } from '../repositories/admin/tenant-database-registry';

export const TENANT_DATABASE_REGISTRY_SIGNATURE_ALGORITHM = 'HMAC-SHA-256';

export interface TenantDatabaseRegistrySignatureKey {
  keyId: string;
  secret: string;
}

export type TenantDatabaseRegistrySignatureStatus =
  | 'valid'
  | 'unsigned'
  | 'invalid'
  | 'not_configured';

export interface TenantDatabaseRegistrySignatureEnv {
  TENANT_DATABASE_REGISTRY_SIGNATURE_SECRET?: string;
  TENANT_DATABASE_REGISTRY_SIGNATURE_KEY_ID?: string;
  TENANT_DATABASE_REGISTRY_PREVIOUS_SIGNATURE_SECRET?: string;
  TENANT_DATABASE_REGISTRY_PREVIOUS_SIGNATURE_KEY_ID?: string;
}

const SIGNED_REGISTRY_FIELDS = [
  'tenant_id',
  'role',
  'provider',
  'database_id',
  'binding_ref',
  'schema_version',
  'status',
  'generation',
  'shard_group',
  'shard_index',
  'shard_count',
  'shard_key_strategy',
  'worker_shard',
  'deployment_target',
  'region_hint',
  'jurisdiction',
] as const;

function base64UrlEncode(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function canonicalizeRegistryRow(row: TenantDatabaseRegistryRow): string {
  const payload: Record<string, unknown> = {};
  for (const field of SIGNED_REGISTRY_FIELDS) {
    payload[field] = row[field] ?? null;
  }
  return JSON.stringify(payload);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signTenantDatabaseRegistryRow(
  row: TenantDatabaseRegistryRow,
  key: TenantDatabaseRegistrySignatureKey
): Promise<{ signature: string; signatureKeyId: string }> {
  const cryptoKey = await importHmacKey(key.secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(canonicalizeRegistryRow(row))
  );
  return {
    signature: base64UrlEncode(signature),
    signatureKeyId: key.keyId,
  };
}

export function loadTenantDatabaseRegistrySignatureKeysFromEnv(
  env: TenantDatabaseRegistrySignatureEnv
): TenantDatabaseRegistrySignatureKey[] {
  const keys: TenantDatabaseRegistrySignatureKey[] = [];
  if (env.TENANT_DATABASE_REGISTRY_SIGNATURE_SECRET) {
    keys.push({
      keyId: env.TENANT_DATABASE_REGISTRY_SIGNATURE_KEY_ID ?? 'current',
      secret: env.TENANT_DATABASE_REGISTRY_SIGNATURE_SECRET,
    });
  }
  if (env.TENANT_DATABASE_REGISTRY_PREVIOUS_SIGNATURE_SECRET) {
    keys.push({
      keyId: env.TENANT_DATABASE_REGISTRY_PREVIOUS_SIGNATURE_KEY_ID ?? 'previous',
      secret: env.TENANT_DATABASE_REGISTRY_PREVIOUS_SIGNATURE_SECRET,
    });
  }
  return keys;
}

export async function verifyTenantDatabaseRegistryRowSignature(
  row: TenantDatabaseRegistryRow,
  keys: TenantDatabaseRegistrySignatureKey[]
): Promise<TenantDatabaseRegistrySignatureStatus> {
  if (keys.length === 0) return 'not_configured';
  if (!row.signature || !row.signature_key_id) return 'unsigned';

  const matchingKeys = keys.filter((key) => key.keyId === row.signature_key_id);
  if (matchingKeys.length === 0) return 'invalid';
  for (const key of matchingKeys) {
    const signed = await signTenantDatabaseRegistryRow(row, key);
    if (signed.signature === row.signature) {
      return 'valid';
    }
  }
  return 'invalid';
}
