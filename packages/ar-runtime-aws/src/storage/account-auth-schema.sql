-- Experimental AWS runtime bootstrap schema; release migrations remain separate.
-- Restore lifecycle and counters from an authenticated source before enabling passkey login.
CREATE TABLE IF NOT EXISTS authrim_aws_account_auth_state (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('active', 'suspended', 'locked', 'deleting', 'deleted', 'inactive')
  ),
  lifecycle_version_ms BIGINT NOT NULL CHECK (lifecycle_version_ms > 0),
  lifecycle_operation_id TEXT,
  revoked_after_ms BIGINT,
  last_login_at_ms BIGINT,
  PRIMARY KEY (tenant_id, user_id),
  CHECK (account_id = 'account:' || user_id)
);

CREATE TABLE IF NOT EXISTS authrim_aws_passkey_counters (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  counter BIGINT NOT NULL CHECK (counter >= 0),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms > 0),
  PRIMARY KEY (tenant_id, user_id, credential_id),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES authrim_aws_account_auth_state (tenant_id, user_id)
    ON DELETE CASCADE
);
