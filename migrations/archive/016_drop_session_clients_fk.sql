-- =============================================================================
-- Migration 016: Remove Foreign Key from session_clients
-- =============================================================================
-- Description: Drop FOREIGN KEY constraint on session_id in session_clients
-- Created: 2025-12-25
--
-- Reason:
-- Sessions are stored in Durable Objects (SessionStore), not in the D1
-- sessions table. The FOREIGN KEY constraint prevents INSERTs from succeeding
-- because the referenced session_id doesn't exist in the sessions table.
--
-- Solution:
-- SQLite doesn't support ALTER TABLE DROP FOREIGN KEY, so we need to:
-- 1. Create a new table without the FK constraint
-- 2. Copy data from the old table
-- 3. Drop the old table
-- 4. Rename the new table
-- =============================================================================

-- Step 1: Create new table without session_id FK (keep client_id FK)
CREATE TABLE session_clients_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_token_at INTEGER NOT NULL,
  last_token_at INTEGER NOT NULL,
  last_seen_at INTEGER,

  -- Only keep the client_id foreign key
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,

  UNIQUE (session_id, client_id)
);

-- Step 2: Copy existing data (if any)
INSERT INTO session_clients_new
SELECT id, session_id, client_id, first_token_at, last_token_at, last_seen_at
FROM session_clients;

-- Step 3: Drop old table
DROP TABLE session_clients;

-- Step 4: Rename new table
ALTER TABLE session_clients_new RENAME TO session_clients;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_session_clients_session_id ON session_clients(session_id);
CREATE INDEX IF NOT EXISTS idx_session_clients_client_id ON session_clients(client_id);
CREATE INDEX IF NOT EXISTS idx_session_clients_last_seen_at ON session_clients(last_seen_at);

-- =============================================================================
-- Migration Complete
-- =============================================================================
