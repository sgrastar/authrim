-- =============================================================================
-- Migration 014: Logout Support
-- =============================================================================
-- Description: Add OIDC Logout support (Backchannel, Frontchannel)
-- Created: 2025-12-23
-- Phase: A-6 (Logout/Session Management)
--
-- Changes:
-- 1. Add logout URI fields to oauth_clients table
-- 2. Create session_clients table for tracking RP sessions
--
-- References:
-- - OIDC Back-Channel Logout 1.0
-- - OIDC Front-Channel Logout 1.0
-- =============================================================================

-- =============================================================================
-- 1. Add Logout Fields to OAuth Clients
-- =============================================================================
-- These fields allow RPs to register their logout endpoints
-- for receiving logout notifications from the OP.

-- Backchannel Logout URI: Server-to-server logout notification endpoint
ALTER TABLE oauth_clients ADD COLUMN backchannel_logout_uri TEXT;

-- Backchannel Logout Session Required: Whether sid claim is required in logout token
-- Default 0 (false) per OIDC spec
ALTER TABLE oauth_clients ADD COLUMN backchannel_logout_session_required INTEGER DEFAULT 0;

-- Frontchannel Logout URI: Browser-based (iframe) logout notification endpoint
ALTER TABLE oauth_clients ADD COLUMN frontchannel_logout_uri TEXT;

-- Frontchannel Logout Session Required: Whether sid is required in frontchannel logout
-- Default 0 (false) per OIDC spec
ALTER TABLE oauth_clients ADD COLUMN frontchannel_logout_session_required INTEGER DEFAULT 0;

-- =============================================================================
-- 2. Create Session-Client Association Table
-- =============================================================================
-- This table tracks which clients (RPs) have been issued tokens for each session.
-- Used to determine which RPs to notify when a user logs out.
--
-- Design rationale:
-- - Sessions table only tracks user sessions, not client associations
-- - When a token is issued to an RP, we record the session-client relationship
-- - On logout, we query this table to find all RPs that need notification
-- - CASCADE delete ensures cleanup when session is deleted
--
-- This is a critical component for proper SSO logout behavior.
-- Auth0/Keycloak have similar internal structures.

CREATE TABLE IF NOT EXISTS session_clients (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Session reference (the user's session)
  session_id TEXT NOT NULL,

  -- Client reference (the RP that received tokens)
  client_id TEXT NOT NULL,

  -- Timestamp when first token was issued to this client for this session
  first_token_at INTEGER NOT NULL,

  -- Timestamp when last token was issued (updated on refresh)
  last_token_at INTEGER NOT NULL,

  -- Timestamp when RP last showed activity (token refresh, userinfo call)
  -- Used for "dead RP" detection - RPs that haven't been active for a long time
  -- can be skipped during logout notification to reduce latency
  last_seen_at INTEGER,

  -- Foreign keys with CASCADE delete
  -- When session is deleted, all session_clients records are automatically removed
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,

  -- Unique constraint: one record per session-client pair
  UNIQUE (session_id, client_id)
);

-- Index for efficient lookup by session (most common query during logout)
CREATE INDEX IF NOT EXISTS idx_session_clients_session_id ON session_clients(session_id);

-- Index for lookup by client (useful for admin/reporting)
CREATE INDEX IF NOT EXISTS idx_session_clients_client_id ON session_clients(client_id);

-- Index for dead RP detection queries
CREATE INDEX IF NOT EXISTS idx_session_clients_last_seen_at ON session_clients(last_seen_at);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Next steps:
-- 1. Update ClientRepository to handle new fields
-- 2. Create SessionClientRepository
-- 3. Integrate session_clients tracking into token issuance
-- 4. Implement backchannel logout sender
-- =============================================================================
