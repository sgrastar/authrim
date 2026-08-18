-- Add retention timestamps/indexes and an explicit current bucket for discovery OTP challenges.

ALTER TABLE lookup_tenant_aliases ADD COLUMN disabled_at INTEGER;

UPDATE lookup_tenant_aliases
   SET disabled_at = COALESCE(disabled_at, updated_at)
 WHERE lifecycle_state = 'disabled';

CREATE TRIGGER IF NOT EXISTS trg_lookup_tenant_alias_disabled_at_insert
AFTER INSERT ON lookup_tenant_aliases
WHEN NEW.lifecycle_state = 'disabled' AND NEW.disabled_at IS NULL
BEGIN
  UPDATE lookup_tenant_aliases
     SET disabled_at = NEW.updated_at
   WHERE virtual_bucket = NEW.virtual_bucket
     AND alias_kind = NEW.alias_kind
     AND alias_sha256_digest = NEW.alias_sha256_digest
     AND tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_tenant_alias_disabled_at_update
AFTER UPDATE OF lifecycle_state ON lookup_tenant_aliases
WHEN NEW.lifecycle_state = 'disabled' AND NEW.disabled_at IS NULL
BEGIN
  UPDATE lookup_tenant_aliases
     SET disabled_at = NEW.updated_at
   WHERE virtual_bucket = NEW.virtual_bucket
     AND alias_kind = NEW.alias_kind
     AND alias_sha256_digest = NEW.alias_sha256_digest
     AND tenant_id = NEW.tenant_id;
END;

ALTER TABLE lookup_discovery_otp_challenges ADD COLUMN virtual_bucket INTEGER
  CHECK (virtual_bucket IS NULL OR virtual_bucket BETWEEN 0 AND 4095);

UPDATE lookup_discovery_otp_challenges
   SET virtual_bucket = CAST(
     substr(
       challenge_id,
       11,
       instr(substr(challenge_id, 11), '-') - 1
     ) AS INTEGER
   )
 WHERE virtual_bucket IS NULL
   AND instr(substr(challenge_id, 11), '-') BETWEEN 2 AND 5
   AND substr(challenge_id, 11, instr(substr(challenge_id, 11), '-') - 1) NOT GLOB '*[^0-9]*'
   AND CAST(
     substr(challenge_id, 11, instr(substr(challenge_id, 11), '-') - 1) AS INTEGER
   ) BETWEEN 0 AND 4095;

-- Deliberately fail the migration if a retained legacy challenge cannot be classified safely.
UPDATE lookup_discovery_otp_challenges
   SET virtual_bucket = -1
 WHERE virtual_bucket IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_lookup_discovery_otp_bucket_required_insert
BEFORE INSERT ON lookup_discovery_otp_challenges
WHEN NEW.virtual_bucket IS NULL
BEGIN
  SELECT RAISE(ABORT, 'lookup_discovery_otp_virtual_bucket_required');
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_discovery_otp_bucket_immutable
BEFORE UPDATE OF virtual_bucket ON lookup_discovery_otp_challenges
WHEN NEW.virtual_bucket IS NULL OR NEW.virtual_bucket <> OLD.virtual_bucket
BEGIN
  SELECT RAISE(ABORT, 'lookup_discovery_otp_virtual_bucket_immutable');
END;

CREATE INDEX IF NOT EXISTS idx_lookup_identifiers_retention
  ON lookup_identifiers(
    lifecycle_state,
    disabled_at,
    tenant_id,
    virtual_bucket,
    index_kind,
    normalization_version,
    hmac_key_generation,
    identifier_blind_digest,
    account_id
  )
  WHERE lifecycle_state = 'disabled';

CREATE INDEX IF NOT EXISTS idx_lookup_tenant_aliases_retention
  ON lookup_tenant_aliases(
    lifecycle_state,
    disabled_at,
    tenant_id,
    virtual_bucket,
    alias_kind,
    alias_sha256_digest
  )
  WHERE lifecycle_state = 'disabled';

CREATE INDEX IF NOT EXISTS idx_lookup_identifier_reservations_retention
  ON lookup_identifier_reservations(
    reservation_state,
    released_at,
    tenant_id,
    virtual_bucket,
    operation_id
  )
  WHERE reservation_state = 'released';

CREATE INDEX IF NOT EXISTS idx_lookup_identifier_replacements_retention
  ON lookup_identifier_replacements(
    gate_state,
    completed_at,
    tenant_id,
    new_virtual_bucket,
    replacement_id,
    hmac_key_generation
  )
  WHERE gate_state = 'completed';

CREATE INDEX IF NOT EXISTS idx_lookup_discovery_otp_cleanup
  ON lookup_discovery_otp_challenges(consumed_at, expires_at, virtual_bucket, challenge_id);
