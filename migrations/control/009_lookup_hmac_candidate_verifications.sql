-- Per-Worker deployment evidence for a Lookup HMAC rotation candidate. The digests are produced
-- from one fixed non-PII test vector; raw HMAC keys and arbitrary oracle inputs are never stored.

CREATE TABLE IF NOT EXISTS control_lookup_hmac_candidate_verifications (
  environment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  verification_phase TEXT NOT NULL CHECK (verification_phase IN ('distribution', 'generation')),
  worker_script_name TEXT NOT NULL,
  current_digest TEXT,
  candidate_digest TEXT,
  observed_state_revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  last_error_code TEXT,
  verified_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, operation_id, verification_phase, worker_script_name),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_hmac_rotation_operations(operation_id, environment_id)
    ON DELETE CASCADE,
  CHECK (
    (status = 'succeeded' AND verification_phase = 'distribution' AND
     length(current_digest) = 64 AND current_digest NOT GLOB '*[^0-9a-f]*' AND
     length(candidate_digest) = 64 AND candidate_digest NOT GLOB '*[^0-9a-f]*' AND
     observed_state_revision IS NULL AND last_error_code IS NULL AND verified_at IS NOT NULL) OR
    (status = 'succeeded' AND verification_phase = 'generation' AND
     current_digest IS NULL AND candidate_digest IS NULL AND
     observed_state_revision >= 1 AND last_error_code IS NULL AND verified_at IS NOT NULL) OR
    (status = 'failed' AND current_digest IS NULL AND candidate_digest IS NULL AND
     observed_state_revision IS NULL AND last_error_code IS NOT NULL AND verified_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_control_lookup_hmac_candidate_verifications_status
  ON control_lookup_hmac_candidate_verifications(
    environment_id, operation_id, verification_phase, status, updated_at
  );
