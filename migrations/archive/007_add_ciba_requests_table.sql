-- Authrim Phase 8: CIBA Support
-- Created: 2025-11-21
-- Description: Adds ciba_requests table for OpenID Connect CIBA Flow
-- Spec: https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html

-- =============================================================================
-- CIBA Requests Table (OIDC CIBA Core 1.0)
-- =============================================================================
-- Stores CIBA authentication requests for Client Initiated Backchannel Authentication
-- Used by CIBARequestStore Durable Object for persistence and recovery
CREATE TABLE ciba_requests (
  auth_req_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,

  -- Login hints (at least one required)
  login_hint TEXT,
  login_hint_token TEXT,
  id_token_hint TEXT,

  -- Optional parameters
  binding_message TEXT,
  user_code TEXT,
  acr_values TEXT,
  requested_expiry INTEGER,

  -- Status and delivery mode
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('poll', 'ping', 'push')),

  -- Notification settings (for ping/push modes)
  client_notification_token TEXT,
  client_notification_endpoint TEXT,

  -- Timing and expiration
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  interval INTEGER NOT NULL DEFAULT 5,

  -- User approval
  user_id TEXT,
  sub TEXT,
  nonce TEXT,

  -- Token issuance tracking
  token_issued INTEGER DEFAULT 0, -- Boolean (0/1)
  token_issued_at INTEGER,

  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for quick auth_req_id lookup
CREATE INDEX idx_ciba_requests_auth_req_id ON ciba_requests(auth_req_id);

-- Index for expiration cleanup
CREATE INDEX idx_ciba_requests_expires_at ON ciba_requests(expires_at);

-- Index for client_id queries
CREATE INDEX idx_ciba_requests_client_id ON ciba_requests(client_id);

-- Index for status queries (pending, approved, etc.)
CREATE INDEX idx_ciba_requests_status ON ciba_requests(status);

-- Index for user_code lookup (if provided)
CREATE INDEX idx_ciba_requests_user_code ON ciba_requests(user_code) WHERE user_code IS NOT NULL;

-- Index for login_hint lookup
CREATE INDEX idx_ciba_requests_login_hint ON ciba_requests(login_hint) WHERE login_hint IS NOT NULL;

-- Index for user_id queries
CREATE INDEX idx_ciba_requests_user_id ON ciba_requests(user_id) WHERE user_id IS NOT NULL;

-- =============================================================================
-- Update oauth_clients table to support CIBA
-- =============================================================================
-- Add CIBA-specific client configuration

-- Add backchannel_token_delivery_mode column
-- Indicates which CIBA delivery modes the client supports
-- Can be: 'poll', 'ping', 'push', or combination like 'poll,ping'
ALTER TABLE oauth_clients ADD COLUMN backchannel_token_delivery_mode TEXT;

-- Add backchannel_client_notification_endpoint column
-- URL where the OP sends notifications (for ping/push modes)
ALTER TABLE oauth_clients ADD COLUMN backchannel_client_notification_endpoint TEXT;

-- Add backchannel_authentication_request_signing_alg column
-- Algorithm used for signed authentication requests (optional)
ALTER TABLE oauth_clients ADD COLUMN backchannel_authentication_request_signing_alg TEXT;

-- Add backchannel_user_code_parameter column
-- Whether the client supports user_code parameter
ALTER TABLE oauth_clients ADD COLUMN backchannel_user_code_parameter INTEGER DEFAULT 0;
