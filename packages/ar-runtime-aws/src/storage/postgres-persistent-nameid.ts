import type { PersistentNameIDStore } from './state-ports';
import type { PostgresQueryClient } from './postgres-transient-state';

import {
  persistentNameIDIdentity as identity,
  validateSAMLPersistentNameIDRecord,
  type SAMLPersistentNameIDRegistryKV,
} from './persistent-nameid-record';
export {
  validateSAMLPersistentNameIDRecord,
  type SAMLPersistentNameIDRecordIdentity,
  type SAMLPersistentNameIDRegistryKV,
} from './persistent-nameid-record';

/** A tenant-bound, durable PostgreSQL registry for SAML persistent NameIDs. */
export class PostgresPersistentNameIDRegistry {
  constructor(private readonly db: PostgresQueryClient) {}

  async get(input: { tenantId: string; key: string }): Promise<string | null> {
    const bound = identity(input.key);
    if (bound.tenantId !== input.tenantId) throw new Error('aws_persistent_nameid_invalid');
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
    if (bound.tenantId !== input.tenantId) throw new Error('aws_persistent_nameid_invalid');
    const result = await this.db.query<{ registry_key: string }>(
      `INSERT INTO authrim_aws_saml_persistent_nameids AS current
         (tenant_id, registry_key, value_json, created_at_ms)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, registry_key) DO UPDATE
         SET value_json = current.value_json
         WHERE (current.value_json::jsonb - 'createdAt') = (EXCLUDED.value_json::jsonb - 'createdAt')
       RETURNING registry_key`,
      [input.tenantId, input.key, input.value, bound.createdAt]
    );
    if (result.rows.length !== 1) throw new Error('aws_persistent_nameid_conflict');
  }
}

/** KV-shaped binding used by the unchanged SAML subject resolver. */
export function createSAMLPersistentNameIDRegistryKV(
  store: PersistentNameIDStore
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
