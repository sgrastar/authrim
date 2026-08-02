-- Lookup stores only blind-index verification gates. Tenant PII owns replacement operations.

DROP TRIGGER IF EXISTS trg_lookup_identifier_replacement_verified_otp_insert;
DROP TRIGGER IF EXISTS trg_lookup_identifier_replacement_verified_otp_update;
DROP TABLE IF EXISTS lookup_identifier_replacements;

CREATE TABLE lookup_identifier_replacements (
  replacement_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (index_kind = 'email_exact'),
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  old_virtual_bucket INTEGER NOT NULL CHECK (old_virtual_bucket BETWEEN 0 AND 4095),
  old_blind_digest TEXT NOT NULL CHECK (length(old_blind_digest) = 64),
  new_virtual_bucket INTEGER NOT NULL CHECK (new_virtual_bucket BETWEEN 0 AND 4095),
  new_blind_digest TEXT NOT NULL CHECK (length(new_blind_digest) = 64),
  gate_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (gate_state IN ('pending', 'authoritative_verified', 'completed', 'blocked')),
  authoritative_checked_at INTEGER,
  completed_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (replacement_id, hmac_key_generation),
  CHECK (old_blind_digest <> new_blind_digest),
  CHECK ((gate_state IN ('authoritative_verified', 'completed') AND
          authoritative_checked_at IS NOT NULL) OR
         gate_state IN ('pending', 'blocked')),
  CHECK ((gate_state = 'completed' AND completed_at IS NOT NULL) OR gate_state <> 'completed')
);

CREATE INDEX idx_lookup_identifier_replacements_repair
  ON lookup_identifier_replacements(gate_state, updated_at);
CREATE INDEX idx_lookup_identifier_replacements_old_bucket
  ON lookup_identifier_replacements(old_virtual_bucket, gate_state);
CREATE INDEX idx_lookup_identifier_replacements_new_bucket
  ON lookup_identifier_replacements(new_virtual_bucket, gate_state);
