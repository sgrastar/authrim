-- Migration: Add acr_values column to external_idp_auth_states
-- Purpose: Store requested ACR values for validation in callback
-- OIDC Core 1.0 Section 3.1.2.1

-- Add acr_values column to store requested authentication context class references
ALTER TABLE external_idp_auth_states ADD COLUMN acr_values TEXT;

-- Add index on consumed_at for cleanup query optimization
CREATE INDEX IF NOT EXISTS idx_external_idp_auth_states_consumed_at
  ON external_idp_auth_states(consumed_at);
