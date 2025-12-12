-- Migration: Add OAuth Client Consents Table
-- Purpose: Track user consent history for OAuth clients
-- Date: 2025-01-20

CREATE TABLE IF NOT EXISTS oauth_client_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  UNIQUE (user_id, client_id)
);

-- Index for faster lookup by user_id and client_id
CREATE INDEX IF NOT EXISTS idx_consents_user_client ON oauth_client_consents(user_id, client_id);

-- Index for cleanup of expired consents
CREATE INDEX IF NOT EXISTS idx_consents_expires_at ON oauth_client_consents(expires_at);
