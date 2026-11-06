-- Indexes for admin notices. The retention job finds handled notices by when they were handled:
-- resolved ones by resolved_at, open ones by when they expired. Partial indexes keep it from
-- scanning open notices, and give each search a fixed order so a batch deletes the rows it
-- selected.
CREATE INDEX idx_admin_notices_resolved_handled
  ON admin_notices(resolved_at, id) WHERE resolved_at IS NOT NULL;
CREATE INDEX idx_admin_notices_expired_open
  ON admin_notices(expires_at, id) WHERE resolved_at IS NULL AND expires_at IS NOT NULL;

-- A notice of an operational event is raised and closed by the event's identity-mapping state,
-- looked up by event.
CREATE INDEX idx_operational_notification_states_event
  ON operational_notification_states(notification_event_id, state);
