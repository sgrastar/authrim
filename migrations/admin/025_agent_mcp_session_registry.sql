-- Coordinate request admission across the per-session McpAgent Durable Objects. This table stores
-- no access token or Tool payload and is safe to delete after the corresponding DO is destroyed.

CREATE TABLE IF NOT EXISTS admin_agent_mcp_sessions (
  session_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  actor_sub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (absolute_expires_at >= expires_at)
);

CREATE INDEX IF NOT EXISTS idx_admin_agent_mcp_sessions_admission
  ON admin_agent_mcp_sessions(tenant_id, grant_id, client_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_agent_mcp_sessions_expiration
  ON admin_agent_mcp_sessions(expires_at, absolute_expires_at);
