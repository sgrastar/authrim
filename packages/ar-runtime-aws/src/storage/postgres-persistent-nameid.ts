import type { PostgresQueryClient } from './postgres-transient-state';

const KEY =
  /^saml:persistent-nameid:tenant:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?):sp:([^:]+):subject:([^:]+)$/u;
const MAX_VALUE_BYTES = 16 * 1024;

export interface SAMLPersistentNameIDRecordIdentity {
  tenantId: string;
  spEntityId: string;
  subjectId: string;
}

export interface SAMLPersistentNameIDRegistryKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

function invalid(): never {
  throw new Error('aws_persistent_nameid_invalid');
}

function identity(key: string): SAMLPersistentNameIDRecordIdentity {
  const match = KEY.exec(key);
  if (!match || key.length > 2048) invalid();
  let spEntityId: string;
  let subjectId: string;
  try {
    spEntityId = decodeURIComponent(match[2]);
    subjectId = decodeURIComponent(match[3]);
  } catch {
    return invalid();
  }
  if (
    !spEntityId ||
    !subjectId ||
    key !==
      `saml:persistent-nameid:tenant:${match[1]}:sp:${encodeURIComponent(spEntityId)}:subject:${encodeURIComponent(subjectId)}`
  ) {
    invalid();
  }
  return { tenantId: match[1], spEntityId, subjectId };
}

/** Validate a source NameID record without querying or mutating PostgreSQL. */
export function validateSAMLPersistentNameIDRecord(
  key: string,
  value: string
): SAMLPersistentNameIDRecordIdentity & { createdAt: number } {
  const bound = identity(key);
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) invalid();
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return invalid();
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    decoded.version !== 1 ||
    decoded.tenantId !== bound.tenantId ||
    decoded.spEntityId !== bound.spEntityId ||
    decoded.subjectId !== bound.subjectId ||
    typeof decoded.nameId !== 'string' ||
    !decoded.nameId ||
    decoded.nameId.length > 4096 ||
    !Number.isSafeInteger(decoded.createdAt) ||
    (decoded.createdAt as number) <= 0
  ) {
    invalid();
  }
  return { ...bound, createdAt: decoded.createdAt as number };
}

/** A tenant-bound, durable PostgreSQL registry for SAML persistent NameIDs. */
export class PostgresPersistentNameIDRegistry {
  constructor(private readonly db: PostgresQueryClient) {}

  async get(input: { tenantId: string; key: string }): Promise<string | null> {
    const bound = identity(input.key);
    if (bound.tenantId !== input.tenantId) invalid();
    const result = await this.db.query<{ value_json: string }>(
      `SELECT value_json FROM authrim_aws_saml_persistent_nameids
       WHERE tenant_id = $1 AND registry_key = $2`,
      [input.tenantId, input.key]
    );
    const value = result.rows[0]?.value_json ?? null;
    if (value !== null) validateSAMLPersistentNameIDRecord(input.key, value);
    return value;
  }

  async put(input: { tenantId: string; key: string; value: string }): Promise<void> {
    const bound = validateSAMLPersistentNameIDRecord(input.key, input.value);
    if (bound.tenantId !== input.tenantId) invalid();
    const result = await this.db.query<{ registry_key: string }>(
      `INSERT INTO authrim_aws_saml_persistent_nameids AS current
         (tenant_id, registry_key, value_json, created_at_ms)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, registry_key) DO UPDATE
         SET value_json = current.value_json
         WHERE current.value_json = EXCLUDED.value_json
       RETURNING registry_key`,
      [input.tenantId, input.key, input.value, bound.createdAt]
    );
    if (result.rows.length !== 1) throw new Error('aws_persistent_nameid_conflict');
  }
}

/** KV-shaped binding used by the unchanged SAML subject resolver. */
export function createSAMLPersistentNameIDRegistryKV(
  store: PostgresPersistentNameIDRegistry
): SAMLPersistentNameIDRegistryKV {
  return {
    get(key) {
      const { tenantId } = identity(key);
      return store.get({ tenantId, key });
    },
    async put(key, value, options) {
      if (options?.expirationTtl !== undefined) {
        throw new Error('aws_persistent_nameid_ttl_unsupported');
      }
      const { tenantId } = identity(key);
      return store.put({ tenantId, key, value });
    },
  };
}
