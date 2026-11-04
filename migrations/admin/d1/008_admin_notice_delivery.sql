-- Email and Slack delivery of admin notices. A notice is planned once (delivery_planned_at): one
-- delivery row per admin to email and per Slack channel, sent by the every-minute job with
-- retries. Admins choose whether and from which severity they get email; channels are registered
-- for the platform or a tenant.
ALTER TABLE admin_notices ADD COLUMN delivery_planned_at INTEGER;
-- Notices from before delivery existed are not sent now.
UPDATE admin_notices SET delivery_planned_at = created_at;
CREATE INDEX idx_admin_notices_delivery_unplanned
  ON admin_notices(created_at, id) WHERE delivery_planned_at IS NULL;

-- One row per admin who changed the defaults (email on, high and above).
CREATE TABLE admin_notice_preferences (
  admin_user_id TEXT PRIMARY KEY NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  email_enabled INTEGER NOT NULL DEFAULT 1 CHECK (email_enabled IN (0, 1)),
  email_min_severity TEXT NOT NULL DEFAULT 'high'
    CHECK (email_min_severity IN ('critical', 'high', 'caution', 'info')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE admin_notice_channels (
  id TEXT PRIMARY KEY NOT NULL,
  -- platform | tenant
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  tenant_id TEXT,
  -- slack
  kind TEXT NOT NULL CHECK (kind IN ('slack')),
  name TEXT NOT NULL,
  -- The Incoming Webhook URL is the secret: encrypted, never returned
  webhook_url_encrypted TEXT NOT NULL,
  -- The non-secret part shown back (e.g. hooks.slack.com/services/T0123/…)
  webhook_url_hint TEXT NOT NULL,
  min_severity TEXT NOT NULL DEFAULT 'high'
    CHECK (min_severity IN ('critical', 'high', 'caution', 'info')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (scope_type = 'platform' AND tenant_id IS NULL)
    OR (scope_type = 'tenant' AND tenant_id IS NOT NULL)
  )
);
CREATE INDEX idx_admin_notice_channels_scope ON admin_notice_channels(scope_type, tenant_id);

CREATE TABLE admin_notice_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  notice_id TEXT NOT NULL REFERENCES admin_notices(id) ON DELETE CASCADE,
  -- email | slack
  channel TEXT NOT NULL CHECK (channel IN ('email', 'slack')),
  -- The admin (email) or the admin_notice_channels row (slack)
  target_id TEXT NOT NULL,
  -- queued | sent | failed | dead_letter | skipped
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'dead_letter', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (notice_id, channel, target_id)
);
CREATE INDEX idx_admin_notice_deliveries_due
  ON admin_notice_deliveries(next_attempt_at, id) WHERE status IN ('queued', 'failed');
CREATE INDEX idx_admin_notice_deliveries_target ON admin_notice_deliveries(target_id);
