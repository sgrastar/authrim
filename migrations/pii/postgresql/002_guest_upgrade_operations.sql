-- Verified guest upgrade operations survive request failure and worker restarts.
-- Sensitive enrollment proof is stored in the account's PII database and erased on completion.
CREATE TABLE guest_upgrade_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  initiating_session_id TEXT NOT NULL,
  request_token_hash TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('email', 'passkey')),
  state TEXT NOT NULL DEFAULT 'awaiting_proof'
    CHECK (state IN ('awaiting_proof', 'verified', 'committing', 'completed', 'canceled')),
  proof_payload_json TEXT,
  challenge_verifier TEXT,
  reservation_publication_json TEXT,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  completed_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (attempt_count >= 0 AND attempt_count <= 5),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_guest_upgrade_operations_account
  ON guest_upgrade_operations (tenant_id, user_id, created_at);
CREATE INDEX idx_guest_upgrade_operations_recovery
  ON guest_upgrade_operations (tenant_id, state, lease_expires_at, updated_at);
