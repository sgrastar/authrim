CREATE TABLE IF NOT EXISTS authrim_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
);

CREATE TABLE IF NOT EXISTS authrim_runtime_probes (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS migration_metadata (
  id TEXT PRIMARY KEY NOT NULL DEFAULT 'global',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    );

-- Apply this entire migration and its history record as one atomic D1 batch.

-- NULL identities are not repaired, removed or assigned automatically.

CREATE TABLE "__authrim_pk_guard" (target TEXT NOT NULL, violations INTEGER NOT NULL CONSTRAINT primary_key_integrity_preflight CHECK (violations = 0));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:authrim_migrations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authrim_migrations' AND sql IN ('CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)','CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:authrim_migrations', (SELECT count(*) FROM "authrim_migrations" WHERE "filename" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:authrim_runtime_probes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authrim_runtime_probes' AND sql IN ('CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )','CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:authrim_runtime_probes', (SELECT count(*) FROM "authrim_runtime_probes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:lookup_directory_job_cursors', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lookup_directory_job_cursors' AND sql IN ('CREATE TABLE lookup_directory_job_cursors (
  job_class TEXT PRIMARY KEY
    CHECK (job_class IN (''routing_outbox'', ''hmac_reindex'', ''bucket_counter_reconciliation'')),
  owner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at INTEGER,
  cursor_json TEXT NOT NULL DEFAULT ''{}''
    CHECK (json_valid(cursor_json) AND length(cursor_json) <= 4096),
  budget_remaining INTEGER NOT NULL DEFAULT 0 CHECK (budget_remaining >= 0),
  last_started_at INTEGER,
  last_completed_at INTEGER,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (
    (owner_id IS NULL AND lease_expires_at IS NULL) OR
    (owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:lookup_directory_job_cursors', (SELECT count(*) FROM "lookup_directory_job_cursors" WHERE "job_class" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:lookup_discovery_otp_challenges', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lookup_discovery_otp_challenges' AND sql IN ('CREATE TABLE lookup_discovery_otp_challenges (
  challenge_id TEXT PRIMARY KEY,
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  email_blind_digest TEXT NOT NULL,
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  previous_email_blind_digest TEXT,
  previous_hmac_key_generation INTEGER
    CHECK (previous_hmac_key_generation IS NULL OR previous_hmac_key_generation >= 1),
  previous_virtual_bucket INTEGER
    CHECK (previous_virtual_bucket IS NULL OR previous_virtual_bucket BETWEEN 0 AND 4095),
  otp_verifier TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT ''pending''
    CHECK (delivery_state IN (''pending'', ''sent'', ''failed'', ''unavailable'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  attempt_limit INTEGER NOT NULL CHECK (attempt_limit BETWEEN 1 AND 20),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  rate_limit_ip_digest TEXT,
  rate_limit_device_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, virtual_bucket INTEGER
  CHECK (virtual_bucket IS NULL OR virtual_bucket BETWEEN 0 AND 4095),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (
    (previous_email_blind_digest IS NULL AND previous_hmac_key_generation IS NULL AND
     previous_virtual_bucket IS NULL) OR
    (previous_email_blind_digest IS NOT NULL AND previous_hmac_key_generation IS NOT NULL AND
     previous_virtual_bucket IS NOT NULL)
  ),
  CHECK (previous_email_blind_digest IS NULL OR
         (previous_email_blind_digest <> email_blind_digest AND
          previous_hmac_key_generation <> hmac_key_generation))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:lookup_discovery_otp_challenges', (SELECT count(*) FROM "lookup_discovery_otp_challenges" WHERE "challenge_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:lookup_schema_metadata', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lookup_schema_metadata' AND sql IN ('CREATE TABLE lookup_schema_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:lookup_schema_metadata', (SELECT count(*) FROM "lookup_schema_metadata" WHERE "metadata_key" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:migration_metadata', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='migration_metadata' AND sql IN ('CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT ''global'',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT ''development'',
  metadata_json TEXT
)','CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY NOT NULL DEFAULT ''global'',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT ''development'',
  metadata_json TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:migration_metadata', (SELECT count(*) FROM "migration_metadata" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_database_migration_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_database_migration_state' AND sql IN ('CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN (''applying'', ''ready'', ''blocked'')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )','CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN (''applying'', ''ready'', ''blocked'')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_database_migration_state', (SELECT count(*) FROM "tenant_database_migration_state" WHERE "stream_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_lookup_discovery_challenge_digest', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_lookup_discovery_challenge_digest' AND sql='CREATE INDEX idx_lookup_discovery_challenge_digest
  ON lookup_discovery_otp_challenges(email_blind_digest, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_lookup_discovery_challenge_expiry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_lookup_discovery_challenge_expiry' AND sql='CREATE INDEX idx_lookup_discovery_challenge_expiry
  ON lookup_discovery_otp_challenges(expires_at, consumed_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_lookup_discovery_otp_cleanup', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_lookup_discovery_otp_cleanup' AND sql='CREATE INDEX idx_lookup_discovery_otp_cleanup
  ON lookup_discovery_otp_challenges(consumed_at, expires_at, virtual_bucket, challenge_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_lookup_discovery_otp_bucket_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_lookup_discovery_otp_bucket_immutable' AND sql='CREATE TRIGGER trg_lookup_discovery_otp_bucket_immutable
BEFORE UPDATE OF virtual_bucket ON lookup_discovery_otp_challenges
WHEN NEW.virtual_bucket IS NULL OR NEW.virtual_bucket <> OLD.virtual_bucket
BEGIN
  SELECT RAISE(ABORT, ''lookup_discovery_otp_virtual_bucket_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_lookup_discovery_otp_bucket_required_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_lookup_discovery_otp_bucket_required_insert' AND sql='CREATE TRIGGER trg_lookup_discovery_otp_bucket_required_insert
BEFORE INSERT ON lookup_discovery_otp_challenges
WHEN NEW.virtual_bucket IS NULL
BEGIN
  SELECT RAISE(ABORT, ''lookup_discovery_otp_virtual_bucket_required'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-schema-objects', (SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (type='view' OR (type IN ('index','trigger') AND tbl_name IN ('authrim_migrations','authrim_runtime_probes','lookup_directory_job_cursors','lookup_discovery_otp_challenges','lookup_schema_metadata','migration_metadata','tenant_database_migration_state'))) AND name NOT IN ('idx_lookup_discovery_challenge_digest','idx_lookup_discovery_challenge_expiry','idx_lookup_discovery_otp_cleanup','trg_lookup_discovery_otp_bucket_immutable','trg_lookup_discovery_otp_bucket_required_insert')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-dependent-table', (WITH candidates AS MATERIALIZED (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT IN ('authrim_migrations','authrim_runtime_probes','lookup_directory_job_cursors','lookup_discovery_otp_challenges','lookup_schema_metadata','migration_metadata','tenant_database_migration_state')) SELECT count(*) FROM candidates s JOIN pragma_foreign_key_list(s.name) f WHERE f."table" IN ('authrim_migrations','authrim_runtime_probes','lookup_directory_job_cursors','lookup_discovery_otp_challenges','lookup_schema_metadata','migration_metadata','tenant_database_migration_state')));

CREATE TABLE "__authrim_pk_copy_authrim_migrations" AS SELECT "rowid" AS "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "authrim_migrations";

CREATE TABLE "__authrim_pk_copy_authrim_runtime_probes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "authrim_runtime_probes";

CREATE TABLE "__authrim_pk_copy_lookup_directory_job_cursors" AS SELECT "rowid" AS "__authrim_original_rowid","job_class","owner_id","fencing_token","lease_expires_at","cursor_json","budget_remaining","last_started_at","last_completed_at","last_error_code","updated_at" FROM "lookup_directory_job_cursors";

CREATE TABLE "__authrim_pk_copy_lookup_discovery_otp_challenges" AS SELECT "rowid" AS "__authrim_original_rowid","challenge_id","normalization_version","email_blind_digest","hmac_key_generation","previous_email_blind_digest","previous_hmac_key_generation","previous_virtual_bucket","otp_verifier","delivery_state","attempt_count","attempt_limit","expires_at","consumed_at","rate_limit_ip_digest","rate_limit_device_digest","created_at","updated_at","virtual_bucket" FROM "lookup_discovery_otp_challenges";

CREATE TABLE "__authrim_pk_copy_lookup_schema_metadata" AS SELECT "rowid" AS "__authrim_original_rowid","metadata_key","metadata_value","updated_at" FROM "lookup_schema_metadata";

CREATE TABLE "__authrim_pk_copy_migration_metadata" AS SELECT "rowid" AS "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "migration_metadata";

CREATE TABLE "__authrim_pk_copy_tenant_database_migration_state" AS SELECT "rowid" AS "__authrim_original_rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at" FROM "tenant_database_migration_state";

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER "trg_lookup_discovery_otp_bucket_immutable";

DROP TRIGGER "trg_lookup_discovery_otp_bucket_required_insert";

DROP TABLE "authrim_migrations";

DROP TABLE "authrim_runtime_probes";

DROP TABLE "lookup_directory_job_cursors";

DROP TABLE "lookup_discovery_otp_challenges";

DROP TABLE "lookup_schema_metadata";

DROP TABLE "migration_metadata";

DROP TABLE "tenant_database_migration_state";

CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY
 NOT NULL
,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
);

CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY
 NOT NULL
,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE lookup_directory_job_cursors (
  job_class TEXT PRIMARY KEY
    CHECK (job_class IN ('routing_outbox', 'hmac_reindex', 'bucket_counter_reconciliation'))
 NOT NULL
,
  owner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at INTEGER,
  cursor_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(cursor_json) AND length(cursor_json) <= 4096),
  budget_remaining INTEGER NOT NULL DEFAULT 0 CHECK (budget_remaining >= 0),
  last_started_at INTEGER,
  last_completed_at INTEGER,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (
    (owner_id IS NULL AND lease_expires_at IS NULL) OR
    (owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE TABLE lookup_discovery_otp_challenges (
  challenge_id TEXT PRIMARY KEY
 NOT NULL
,
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  email_blind_digest TEXT NOT NULL,
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  previous_email_blind_digest TEXT,
  previous_hmac_key_generation INTEGER
    CHECK (previous_hmac_key_generation IS NULL OR previous_hmac_key_generation >= 1),
  previous_virtual_bucket INTEGER
    CHECK (previous_virtual_bucket IS NULL OR previous_virtual_bucket BETWEEN 0 AND 4095),
  otp_verifier TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'sent', 'failed', 'unavailable')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  attempt_limit INTEGER NOT NULL CHECK (attempt_limit BETWEEN 1 AND 20),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  rate_limit_ip_digest TEXT,
  rate_limit_device_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, virtual_bucket INTEGER
  CHECK (virtual_bucket IS NULL OR virtual_bucket BETWEEN 0 AND 4095),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (
    (previous_email_blind_digest IS NULL AND previous_hmac_key_generation IS NULL AND
     previous_virtual_bucket IS NULL) OR
    (previous_email_blind_digest IS NOT NULL AND previous_hmac_key_generation IS NOT NULL AND
     previous_virtual_bucket IS NOT NULL)
  ),
  CHECK (previous_email_blind_digest IS NULL OR
         (previous_email_blind_digest <> email_blind_digest AND
          previous_hmac_key_generation <> hmac_key_generation))
);

CREATE TABLE lookup_schema_metadata (
  metadata_key TEXT PRIMARY KEY
 NOT NULL
,
  metadata_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global'
 NOT NULL
,
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);

CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY
 NOT NULL
,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX idx_lookup_discovery_challenge_digest
  ON lookup_discovery_otp_challenges(email_blind_digest, created_at DESC);

CREATE INDEX idx_lookup_discovery_challenge_expiry
  ON lookup_discovery_otp_challenges(expires_at, consumed_at);

CREATE INDEX idx_lookup_discovery_otp_cleanup
  ON lookup_discovery_otp_challenges(consumed_at, expires_at, virtual_bucket, challenge_id);

INSERT INTO "authrim_migrations" ("rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version") SELECT "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "__authrim_pk_copy_authrim_migrations";

INSERT INTO "authrim_runtime_probes" ("rowid","id","tenant_id","role","probe_kind","nonce","created_at") SELECT "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "__authrim_pk_copy_authrim_runtime_probes";

INSERT INTO "lookup_directory_job_cursors" ("rowid","job_class","owner_id","fencing_token","lease_expires_at","cursor_json","budget_remaining","last_started_at","last_completed_at","last_error_code","updated_at") SELECT "__authrim_original_rowid","job_class","owner_id","fencing_token","lease_expires_at","cursor_json","budget_remaining","last_started_at","last_completed_at","last_error_code","updated_at" FROM "__authrim_pk_copy_lookup_directory_job_cursors";

INSERT INTO "lookup_discovery_otp_challenges" ("rowid","challenge_id","normalization_version","email_blind_digest","hmac_key_generation","previous_email_blind_digest","previous_hmac_key_generation","previous_virtual_bucket","otp_verifier","delivery_state","attempt_count","attempt_limit","expires_at","consumed_at","rate_limit_ip_digest","rate_limit_device_digest","created_at","updated_at","virtual_bucket") SELECT "__authrim_original_rowid","challenge_id","normalization_version","email_blind_digest","hmac_key_generation","previous_email_blind_digest","previous_hmac_key_generation","previous_virtual_bucket","otp_verifier","delivery_state","attempt_count","attempt_limit","expires_at","consumed_at","rate_limit_ip_digest","rate_limit_device_digest","created_at","updated_at","virtual_bucket" FROM "__authrim_pk_copy_lookup_discovery_otp_challenges";

INSERT INTO "lookup_schema_metadata" ("rowid","metadata_key","metadata_value","updated_at") SELECT "__authrim_original_rowid","metadata_key","metadata_value","updated_at" FROM "__authrim_pk_copy_lookup_schema_metadata";

INSERT INTO "migration_metadata" ("rowid","id","current_version","last_migration_at","environment","metadata_json") SELECT "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "__authrim_pk_copy_migration_metadata";

INSERT INTO "tenant_database_migration_state" ("rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at") SELECT "__authrim_original_rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at" FROM "__authrim_pk_copy_tenant_database_migration_state";

CREATE TRIGGER trg_lookup_discovery_otp_bucket_immutable
BEFORE UPDATE OF virtual_bucket ON lookup_discovery_otp_challenges
WHEN NEW.virtual_bucket IS NULL OR NEW.virtual_bucket <> OLD.virtual_bucket
BEGIN
  SELECT RAISE(ABORT, 'lookup_discovery_otp_virtual_bucket_immutable');
END;

CREATE TRIGGER trg_lookup_discovery_otp_bucket_required_insert
BEFORE INSERT ON lookup_discovery_otp_challenges
WHEN NEW.virtual_bucket IS NULL
BEGIN
  SELECT RAISE(ABORT, 'lookup_discovery_otp_virtual_bucket_required');
END;

INSERT INTO "__authrim_pk_guard" VALUES ('foreign-key-check', (SELECT count(*) FROM pragma_foreign_key_check));

DROP TABLE "__authrim_pk_copy_authrim_migrations";

DROP TABLE "__authrim_pk_copy_authrim_runtime_probes";

DROP TABLE "__authrim_pk_copy_lookup_directory_job_cursors";

DROP TABLE "__authrim_pk_copy_lookup_discovery_otp_challenges";

DROP TABLE "__authrim_pk_copy_lookup_schema_metadata";

DROP TABLE "__authrim_pk_copy_migration_metadata";

DROP TABLE "__authrim_pk_copy_tenant_database_migration_state";

DROP TABLE "__authrim_pk_guard";

PRAGMA defer_foreign_keys = OFF;
