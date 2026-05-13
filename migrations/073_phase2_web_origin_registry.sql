-- Phase 2: Dedicated web origin registry
--
-- Source-of-truth storage for LoginUI/SDK browser origin metadata.
-- oauth_clients.allowed_redirect_origins remains for legacy custom redirect URI validation,
-- but browser handoff/CORS/iframe metadata is stored here.

CREATE TABLE IF NOT EXISTS web_origin_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  cors_allowed INTEGER NOT NULL DEFAULT 1,
  csp_frame_ancestors TEXT,
  handoff_allowed INTEGER NOT NULL DEFAULT 1,
  iframe_allowed INTEGER NOT NULL DEFAULT 0,
  environment TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, origin)
);

CREATE INDEX IF NOT EXISTS idx_web_origin_registry_client
  ON web_origin_registry(tenant_id, client_id, is_active);

CREATE INDEX IF NOT EXISTS idx_web_origin_registry_origin
  ON web_origin_registry(tenant_id, origin, is_active);
