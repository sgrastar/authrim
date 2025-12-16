-- Migration: Add max_age and consumed_at columns to external_idp_auth_states
-- Purpose:
--   max_age: Support OIDC auth_time validation when max_age is requested (OIDC Core 1.0 Section 3.1.3.7 step 11)
--   consumed_at: Enable atomic single-use state consumption (prevents race condition attacks)

ALTER TABLE external_idp_auth_states ADD COLUMN max_age INTEGER;
ALTER TABLE external_idp_auth_states ADD COLUMN consumed_at INTEGER;

-- Index for cleanup query optimization
CREATE INDEX IF NOT EXISTS idx_external_idp_auth_states_consumed_at
  ON external_idp_auth_states(consumed_at);
