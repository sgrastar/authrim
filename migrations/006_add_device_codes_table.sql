-- Authrim Phase 7: Device Flow Support
-- Created: 2025-11-21
-- Description: Adds device_codes table for RFC 8628 Device Authorization Grant
-- RFC: https://datatracker.ietf.org/doc/html/rfc8628

-- =============================================================================
-- Device Codes Table (RFC 8628)
-- =============================================================================
-- Stores device authorization codes for Device Flow
-- Used by DeviceCodeStore Durable Object for persistence and recovery
CREATE TABLE device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  user_id TEXT,
  sub TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

-- Index for quick user_code lookup (user enters this code)
CREATE INDEX idx_device_codes_user_code ON device_codes(user_code);

-- Index for expiration cleanup
CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at);

-- Index for client_id queries
CREATE INDEX idx_device_codes_client_id ON device_codes(client_id);

-- Index for status queries (pending, approved, etc.)
CREATE INDEX idx_device_codes_status ON device_codes(status);
