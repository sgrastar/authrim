-- Signed Lookup blind-index HMAC key state. Secret material remains in Worker secret slots.

CREATE TABLE IF NOT EXISTS control_lookup_hmac_key_states (
  environment_id TEXT PRIMARY KEY,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  rotation_state TEXT NOT NULL
    CHECK (rotation_state IN (
      'stable', 'activation_dual_write', 'dual_read', 'reindexing',
      'verifying', 'grace', 'blocked'
    )),
  write_mode TEXT NOT NULL CHECK (write_mode IN ('current_only', 'dual_write')),
  current_key_generation INTEGER NOT NULL CHECK (current_key_generation >= 1),
  current_key_id TEXT NOT NULL,
  current_key_slot TEXT NOT NULL CHECK (current_key_slot IN ('A', 'B')),
  current_key_fingerprint TEXT NOT NULL
    CHECK (length(current_key_fingerprint) = 64 AND
           current_key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  previous_key_generation INTEGER,
  previous_key_id TEXT,
  previous_key_slot TEXT CHECK (previous_key_slot IN ('A', 'B')),
  previous_key_fingerprint TEXT
    CHECK (previous_key_fingerprint IS NULL OR
           (length(previous_key_fingerprint) = 64 AND
            previous_key_fingerprint NOT GLOB '*[^0-9a-f]*')),
  operation_id TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK (
    (previous_key_generation IS NULL AND previous_key_id IS NULL AND
     previous_key_slot IS NULL AND previous_key_fingerprint IS NULL) OR
    (previous_key_generation IS NOT NULL AND previous_key_id IS NOT NULL AND
     previous_key_slot IS NOT NULL AND previous_key_fingerprint IS NOT NULL)
  ),
  CHECK (write_mode <> 'dual_write' OR previous_key_generation IS NOT NULL),
  CHECK (rotation_state <> 'activation_dual_write' OR write_mode = 'dual_write'),
  CHECK (rotation_state <> 'stable' OR
         (write_mode = 'current_only' AND previous_key_generation IS NULL)),
  CHECK (previous_key_generation IS NULL OR
         (previous_key_generation <> current_key_generation AND
          previous_key_id <> current_key_id AND
          previous_key_slot <> current_key_slot AND
          previous_key_fingerprint <> current_key_fingerprint))
);

CREATE TABLE IF NOT EXISTS control_lookup_hmac_key_state_publications (
  environment_id TEXT PRIMARY KEY,
  publication_generation INTEGER NOT NULL CHECK (publication_generation >= 1),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  state_digest TEXT NOT NULL
    CHECK (length(state_digest) = 64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  snapshot_jws TEXT NOT NULL CHECK (length(snapshot_jws) BETWEEN 64 AND 16384),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  status TEXT NOT NULL CHECK (status IN ('publishing', 'active')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_lookup_hmac_key_states(environment_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_control_lookup_hmac_key_state_publication_due
  ON control_lookup_hmac_key_state_publications(status, expires_at, updated_at);

-- Frozen authoritative source inventory for one HMAC rotation. New rows written after
-- current-only activation already use the candidate key and do not need this backfill.
CREATE TABLE IF NOT EXISTS control_lookup_hmac_rotation_sources (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('account_id', 'email_exact', 'external_subject')),
  data_role TEXT NOT NULL CHECK (data_role IN ('tenant_core/users', 'tenant_pii')),
  shard_id TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  cutoff_at INTEGER NOT NULL CHECK (cutoff_at >= 1),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'complete', 'blocked')),
  cursor_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(cursor_json) AND length(cursor_json) <= 4096),
  source_row_count INTEGER NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, source_kind, shard_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_hmac_rotation_operations(operation_id, environment_id) ON DELETE CASCADE,
  CHECK ((source_kind = 'account_id' AND data_role = 'tenant_core/users') OR
         (source_kind = 'email_exact' AND data_role = 'tenant_pii') OR
         (source_kind = 'external_subject' AND
          data_role IN ('tenant_core/users', 'tenant_pii'))),
  CHECK ((state = 'complete' AND completed_at IS NOT NULL) OR state <> 'complete')
);

CREATE INDEX IF NOT EXISTS idx_control_lookup_hmac_rotation_source_due
  ON control_lookup_hmac_rotation_sources(environment_id, operation_id, state, source_kind, shard_id);

-- Per-physical-shard evidence for the candidate generation. This keeps verification bounded and
-- resumable while preventing a request Worker from asserting an unverified aggregate result.
CREATE TABLE IF NOT EXISTS control_lookup_hmac_rotation_verification_shards (
  operation_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  lookup_shard_id TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'complete', 'blocked')),
  cursor_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(cursor_json) AND length(cursor_json) <= 4096),
  current_row_count INTEGER NOT NULL DEFAULT 0 CHECK (current_row_count >= 0),
  current_rows_valid INTEGER NOT NULL DEFAULT 1 CHECK (current_rows_valid IN (0, 1)),
  reservations_valid INTEGER NOT NULL DEFAULT 1 CHECK (reservations_valid IN (0, 1)),
  route_references_valid INTEGER NOT NULL DEFAULT 1 CHECK (route_references_valid IN (0, 1)),
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, lookup_shard_id),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_hmac_rotation_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (lookup_shard_id, environment_id)
    REFERENCES control_lookup_physical_shards(lookup_shard_id, environment_id),
  CHECK ((state = 'complete' AND completed_at IS NOT NULL) OR state <> 'complete')
);

CREATE INDEX IF NOT EXISTS idx_control_lookup_hmac_rotation_verification_due
  ON control_lookup_hmac_rotation_verification_shards(
    environment_id, operation_id, state, lookup_shard_id
  );
