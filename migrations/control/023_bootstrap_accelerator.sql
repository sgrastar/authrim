-- One-time, short-lived proofs and a single-flight lease for setup-driven initial bootstrap
-- acceleration. The proof key is domain-separated from runtime smoke RPC even though setup signs
-- it with the same Control-owned Ed25519 key material.

CREATE TABLE IF NOT EXISTS control_bootstrap_accelerator_proofs (
  environment_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, jti),
  FOREIGN KEY (environment_id)
    REFERENCES control_bootstrap_handoffs(environment_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_control_bootstrap_accelerator_proofs_expiry
  ON control_bootstrap_accelerator_proofs(environment_id, expires_at);

CREATE TABLE IF NOT EXISTS control_bootstrap_accelerator_leases (
  environment_id TEXT PRIMARY KEY,
  owner_jti TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id, owner_jti)
    REFERENCES control_bootstrap_accelerator_proofs(environment_id, jti) ON DELETE CASCADE,
  FOREIGN KEY (environment_id)
    REFERENCES control_bootstrap_handoffs(environment_id) ON DELETE CASCADE
);
