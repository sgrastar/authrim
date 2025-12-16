-- Migration: Add external provider mapping to sessions for backchannel logout support
-- This enables terminating sessions when an IdP sends a backchannel logout request

-- Add columns for external provider tracking
ALTER TABLE sessions ADD COLUMN external_provider_id TEXT;
ALTER TABLE sessions ADD COLUMN external_provider_sub TEXT;

-- Index for efficient backchannel logout queries
-- When IdP sends logout, we need to find all sessions for (provider_id, provider_sub)
CREATE INDEX IF NOT EXISTS idx_sessions_external_provider
  ON sessions(external_provider_id, external_provider_sub);
