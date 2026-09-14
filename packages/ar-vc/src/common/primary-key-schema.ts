// Append-only schema upgrade for the SQLite-backed VC stores.
export const VCI_INITIAL_SCHEMA = `
      CREATE TABLE IF NOT EXISTS credential_offers (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        credential_profile_id TEXT NOT NULL,
        credential_profile_version INTEGER NOT NULL,
        credential_profile_snapshot_hash TEXT NOT NULL,
        credential_configuration_id TEXT NOT NULL,
        mapping_version_id TEXT NOT NULL,
        mapping_snapshot_hash TEXT NOT NULL,
        claim_manifest_hash TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        tx_code_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','processing','consumed','locked','expired')),
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS credential_offers_expiry_idx
        ON credential_offers(status, expires_at);
      CREATE TABLE IF NOT EXISTS proof_nonces (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('issued','processing','consumed','expired')),
        proof_fingerprint TEXT UNIQUE,
        access_token_jti TEXT,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proof_nonces_expiry_idx ON proof_nonces(status, expires_at);
`;

export const VCI_PRIMARY_KEY_MIGRATION = `-- Apply this entire migration and its history record as one atomic D1 batch.

-- NULL identities are not repaired, removed or assigned automatically.

CREATE TABLE "__authrim_pk_guard" (target TEXT NOT NULL, violations INTEGER NOT NULL CONSTRAINT primary_key_integrity_preflight CHECK (violations = 0));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:credential_offers', (SELECT CASE WHEN count(*) = 1 AND min(sql) IN ('CREATE TABLE credential_offers (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        credential_profile_id TEXT NOT NULL,
        credential_profile_version INTEGER NOT NULL,
        credential_profile_snapshot_hash TEXT NOT NULL,
        credential_configuration_id TEXT NOT NULL,
        mapping_version_id TEXT NOT NULL,
        mapping_snapshot_hash TEXT NOT NULL,
        claim_manifest_hash TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        tx_code_hash TEXT,
        status TEXT NOT NULL CHECK (status IN (''pending'',''processing'',''consumed'',''locked'',''expired'')),
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )','CREATE TABLE credential_offers (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        credential_profile_id TEXT NOT NULL,
        credential_profile_version INTEGER NOT NULL,
        credential_profile_snapshot_hash TEXT NOT NULL,
        credential_configuration_id TEXT NOT NULL,
        mapping_version_id TEXT NOT NULL,
        mapping_snapshot_hash TEXT NOT NULL,
        claim_manifest_hash TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        tx_code_hash TEXT,
        status TEXT NOT NULL CHECK (status IN (''pending'',''processing'',''consumed'',''locked'',''expired'')),
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )') THEN 0 ELSE 1 END FROM sqlite_schema WHERE type='table' AND name='credential_offers'));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:credential_offers', (SELECT count(*) FROM "credential_offers" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:proof_nonces', (SELECT CASE WHEN count(*) = 1 AND min(sql) IN ('CREATE TABLE proof_nonces (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN (''issued'',''processing'',''consumed'',''expired'')),
        proof_fingerprint TEXT UNIQUE,
        access_token_jti TEXT,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )','CREATE TABLE proof_nonces (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN (''issued'',''processing'',''consumed'',''expired'')),
        proof_fingerprint TEXT UNIQUE,
        access_token_jti TEXT,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )') THEN 0 ELSE 1 END FROM sqlite_schema WHERE type='table' AND name='proof_nonces'));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:proof_nonces', (SELECT count(*) FROM "proof_nonces" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('object:credential_offers_expiry_idx', (SELECT CASE WHEN count(*) = 1 AND min(sql) = 'CREATE INDEX credential_offers_expiry_idx
        ON credential_offers(status, expires_at)' THEN 0 ELSE 1 END FROM sqlite_schema WHERE type='index' AND name='credential_offers_expiry_idx'));

INSERT INTO "__authrim_pk_guard" VALUES ('object:proof_nonces_expiry_idx', (SELECT CASE WHEN count(*) = 1 AND min(sql) = 'CREATE INDEX proof_nonces_expiry_idx ON proof_nonces(status, expires_at)' THEN 0 ELSE 1 END FROM sqlite_schema WHERE type='index' AND name='proof_nonces_expiry_idx'));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-schema-objects', (SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (type='view' OR (type IN ('index','trigger') AND tbl_name IN ('credential_offers','proof_nonces'))) AND name NOT IN ('credential_offers_expiry_idx','proof_nonces_expiry_idx')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-dependent-table', (WITH candidates AS MATERIALIZED (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT IN ('credential_offers','proof_nonces')) SELECT count(*) FROM candidates s JOIN pragma_foreign_key_list(s.name) f WHERE f."table" IN ('credential_offers','proof_nonces')));

CREATE TABLE "__authrim_pk_copy_credential_offers" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","credential_profile_id","credential_profile_version","credential_profile_snapshot_hash","credential_configuration_id","mapping_version_id","mapping_snapshot_hash","claim_manifest_hash","claims_json","code_hash","tx_code_hash","status","failed_attempts","max_attempts","reservation_id","lease_expires_at","created_at","expires_at" FROM "credential_offers";

CREATE TABLE "__authrim_pk_copy_proof_nonces" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","nonce_hash","status","proof_fingerprint","access_token_jti","reservation_id","lease_expires_at","created_at","expires_at" FROM "proof_nonces";

PRAGMA defer_foreign_keys = ON;

DROP TABLE "credential_offers";

DROP TABLE "proof_nonces";

CREATE TABLE credential_offers (
        id TEXT PRIMARY KEY
 NOT NULL
,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        credential_profile_id TEXT NOT NULL,
        credential_profile_version INTEGER NOT NULL,
        credential_profile_snapshot_hash TEXT NOT NULL,
        credential_configuration_id TEXT NOT NULL,
        mapping_version_id TEXT NOT NULL,
        mapping_snapshot_hash TEXT NOT NULL,
        claim_manifest_hash TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        tx_code_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','processing','consumed','locked','expired')),
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

CREATE TABLE proof_nonces (
        id TEXT PRIMARY KEY
 NOT NULL
,
        tenant_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('issued','processing','consumed','expired')),
        proof_fingerprint TEXT UNIQUE,
        access_token_jti TEXT,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

CREATE INDEX credential_offers_expiry_idx
        ON credential_offers(status, expires_at);

CREATE INDEX proof_nonces_expiry_idx ON proof_nonces(status, expires_at);

INSERT INTO "credential_offers" ("rowid","id","tenant_id","user_id","credential_profile_id","credential_profile_version","credential_profile_snapshot_hash","credential_configuration_id","mapping_version_id","mapping_snapshot_hash","claim_manifest_hash","claims_json","code_hash","tx_code_hash","status","failed_attempts","max_attempts","reservation_id","lease_expires_at","created_at","expires_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","credential_profile_id","credential_profile_version","credential_profile_snapshot_hash","credential_configuration_id","mapping_version_id","mapping_snapshot_hash","claim_manifest_hash","claims_json","code_hash","tx_code_hash","status","failed_attempts","max_attempts","reservation_id","lease_expires_at","created_at","expires_at" FROM "__authrim_pk_copy_credential_offers";

INSERT INTO "proof_nonces" ("rowid","id","tenant_id","nonce_hash","status","proof_fingerprint","access_token_jti","reservation_id","lease_expires_at","created_at","expires_at") SELECT "__authrim_original_rowid","id","tenant_id","nonce_hash","status","proof_fingerprint","access_token_jti","reservation_id","lease_expires_at","created_at","expires_at" FROM "__authrim_pk_copy_proof_nonces";

INSERT INTO "__authrim_pk_guard" VALUES ('foreign-key-check', (SELECT count(*) FROM pragma_foreign_key_check));

DROP TABLE "__authrim_pk_copy_credential_offers";

DROP TABLE "__authrim_pk_copy_proof_nonces";

DROP TABLE "__authrim_pk_guard";

PRAGMA defer_foreign_keys = OFF;
`;

export const VP_INITIAL_SCHEMA = `
      CREATE TABLE IF NOT EXISTS vp_requests (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id TEXT,
        credential_profile_id TEXT,
        credential_profile_version_id TEXT,
        verification_flow_version_id TEXT,
        verification_mapping_version_id TEXT,
        verification_mapping_snapshot_hash TEXT,
        maximum_attribute_age_seconds INTEGER,
        nonce TEXT NOT NULL UNIQUE,
        status_token_hash TEXT NOT NULL,
        presentation_definition_json TEXT,
        dcql_query_json TEXT,
        response_uri TEXT NOT NULL,
        response_mode TEXT NOT NULL CHECK (response_mode IN ('direct_post','direct_post.jwt')),
        status TEXT NOT NULL CHECK (status IN ('pending','processing','verified','failed','expired')),
        response_fingerprint TEXT UNIQUE,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        verified_claim_names_json TEXT,
        error_code TEXT,
        error_description TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vp_requests_expiry_idx ON vp_requests(status, expires_at);
`;

export const VP_PRIMARY_KEY_MIGRATION = `-- Apply this entire migration and its history record as one atomic D1 batch.

-- NULL identities are not repaired, removed or assigned automatically.

CREATE TABLE "__authrim_pk_guard" (target TEXT NOT NULL, violations INTEGER NOT NULL CONSTRAINT primary_key_integrity_preflight CHECK (violations = 0));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:vp_requests', (SELECT CASE WHEN count(*) = 1 AND min(sql) IN ('CREATE TABLE vp_requests (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id TEXT,
        credential_profile_id TEXT,
        credential_profile_version_id TEXT,
        verification_flow_version_id TEXT,
        verification_mapping_version_id TEXT,
        verification_mapping_snapshot_hash TEXT,
        maximum_attribute_age_seconds INTEGER,
        nonce TEXT NOT NULL UNIQUE,
        status_token_hash TEXT NOT NULL,
        presentation_definition_json TEXT,
        dcql_query_json TEXT,
        response_uri TEXT NOT NULL,
        response_mode TEXT NOT NULL CHECK (response_mode IN (''direct_post'',''direct_post.jwt'')),
        status TEXT NOT NULL CHECK (status IN (''pending'',''processing'',''verified'',''failed'',''expired'')),
        response_fingerprint TEXT UNIQUE,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        verified_claim_names_json TEXT,
        error_code TEXT,
        error_description TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )','CREATE TABLE vp_requests (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id TEXT,
        credential_profile_id TEXT,
        credential_profile_version_id TEXT,
        verification_flow_version_id TEXT,
        verification_mapping_version_id TEXT,
        verification_mapping_snapshot_hash TEXT,
        maximum_attribute_age_seconds INTEGER,
        nonce TEXT NOT NULL UNIQUE,
        status_token_hash TEXT NOT NULL,
        presentation_definition_json TEXT,
        dcql_query_json TEXT,
        response_uri TEXT NOT NULL,
        response_mode TEXT NOT NULL CHECK (response_mode IN (''direct_post'',''direct_post.jwt'')),
        status TEXT NOT NULL CHECK (status IN (''pending'',''processing'',''verified'',''failed'',''expired'')),
        response_fingerprint TEXT UNIQUE,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        verified_claim_names_json TEXT,
        error_code TEXT,
        error_description TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )') THEN 0 ELSE 1 END FROM sqlite_schema WHERE type='table' AND name='vp_requests'));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:vp_requests', (SELECT count(*) FROM "vp_requests" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('object:vp_requests_expiry_idx', (SELECT CASE WHEN count(*) = 1 AND min(sql) = 'CREATE INDEX vp_requests_expiry_idx ON vp_requests(status, expires_at)' THEN 0 ELSE 1 END FROM sqlite_schema WHERE type='index' AND name='vp_requests_expiry_idx'));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-schema-objects', (SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (type='view' OR (type IN ('index','trigger') AND tbl_name IN ('vp_requests'))) AND name NOT IN ('vp_requests_expiry_idx')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-dependent-table', (WITH candidates AS MATERIALIZED (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT IN ('vp_requests')) SELECT count(*) FROM candidates s JOIN pragma_foreign_key_list(s.name) f WHERE f."table" IN ('vp_requests')));

CREATE TABLE "__authrim_pk_copy_vp_requests" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","client_id","user_id","credential_profile_id","credential_profile_version_id","verification_flow_version_id","verification_mapping_version_id","verification_mapping_snapshot_hash","maximum_attribute_age_seconds","nonce","status_token_hash","presentation_definition_json","dcql_query_json","response_uri","response_mode","status","response_fingerprint","reservation_id","lease_expires_at","verified_claim_names_json","error_code","error_description","created_at","expires_at" FROM "vp_requests";

PRAGMA defer_foreign_keys = ON;

DROP TABLE "vp_requests";

CREATE TABLE vp_requests (
        id TEXT PRIMARY KEY
 NOT NULL
,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id TEXT,
        credential_profile_id TEXT,
        credential_profile_version_id TEXT,
        verification_flow_version_id TEXT,
        verification_mapping_version_id TEXT,
        verification_mapping_snapshot_hash TEXT,
        maximum_attribute_age_seconds INTEGER,
        nonce TEXT NOT NULL UNIQUE,
        status_token_hash TEXT NOT NULL,
        presentation_definition_json TEXT,
        dcql_query_json TEXT,
        response_uri TEXT NOT NULL,
        response_mode TEXT NOT NULL CHECK (response_mode IN ('direct_post','direct_post.jwt')),
        status TEXT NOT NULL CHECK (status IN ('pending','processing','verified','failed','expired')),
        response_fingerprint TEXT UNIQUE,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        verified_claim_names_json TEXT,
        error_code TEXT,
        error_description TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

CREATE INDEX vp_requests_expiry_idx ON vp_requests(status, expires_at);

INSERT INTO "vp_requests" ("rowid","id","tenant_id","client_id","user_id","credential_profile_id","credential_profile_version_id","verification_flow_version_id","verification_mapping_version_id","verification_mapping_snapshot_hash","maximum_attribute_age_seconds","nonce","status_token_hash","presentation_definition_json","dcql_query_json","response_uri","response_mode","status","response_fingerprint","reservation_id","lease_expires_at","verified_claim_names_json","error_code","error_description","created_at","expires_at") SELECT "__authrim_original_rowid","id","tenant_id","client_id","user_id","credential_profile_id","credential_profile_version_id","verification_flow_version_id","verification_mapping_version_id","verification_mapping_snapshot_hash","maximum_attribute_age_seconds","nonce","status_token_hash","presentation_definition_json","dcql_query_json","response_uri","response_mode","status","response_fingerprint","reservation_id","lease_expires_at","verified_claim_names_json","error_code","error_description","created_at","expires_at" FROM "__authrim_pk_copy_vp_requests";

INSERT INTO "__authrim_pk_guard" VALUES ('foreign-key-check', (SELECT count(*) FROM pragma_foreign_key_check));

DROP TABLE "__authrim_pk_copy_vp_requests";

DROP TABLE "__authrim_pk_guard";

PRAGMA defer_foreign_keys = OFF;
`;

/** A failed rebuild rolls back before the object's constructor admits requests. */
export function initializeCredentialStoreSchema(
  storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>,
  initialSql: string,
  migrationSql: string,
  tables: readonly string[]
): void {
  storage.transactionSync(() => {
    storage.sql.exec(initialSql);
    const needsMigration = tables.some((table) => {
      if (!/^[a-z_]+$/.test(table)) throw new Error('invalid_vc_schema_table');
      const columns = storage.sql
        .exec<{ pk: number; notnull: number }>(`PRAGMA table_info("${table}")`)
        .toArray();
      const keys = columns.filter((column) => column.pk > 0);
      if (keys.length === 0) throw new Error('vc_primary_key_schema_missing');
      return keys.some((column) => column.notnull !== 1);
    });
    if (needsMigration) storage.sql.exec(migrationSql);
  });
}
